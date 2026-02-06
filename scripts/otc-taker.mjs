#!/usr/bin/env node
import process from 'node:process';
import crypto from 'node:crypto';

import { ScBridgeClient } from '../src/sc-bridge/client.js';
import { createUnsignedEnvelope, attachSignature } from '../src/protocol/signedMessage.js';
import { KIND, ASSET, PAIR } from '../src/swap/constants.js';
import { validateSwapEnvelope } from '../src/swap/schema.js';
import { hashUnsignedEnvelope } from '../src/swap/hash.js';

function die(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) flags.set(key, true);
      else {
        flags.set(key, next);
        i += 1;
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

function requireFlag(flags, name) {
  const v = flags.get(name);
  if (!v || v === true) die(`Missing --${name}`);
  return String(v);
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (value === true) return true;
  const s = String(value).trim().toLowerCase();
  if (!s) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(s);
}

function parseIntFlag(value, label, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) die(`Invalid ${label}`);
  return n;
}

function stripSignature(envelope) {
  if (!envelope || typeof envelope !== 'object') return envelope;
  const { sig: _sig, signer: _signer, ...unsigned } = envelope;
  return unsigned;
}

function ensureOk(res, label) {
  if (!res || typeof res !== 'object') throw new Error(`${label} failed (no response)`);
  if (res.type === 'error') throw new Error(`${label} failed: ${res.error}`);
  return res;
}

async function signViaBridge(sc, payload) {
  const res = await sc.sign(payload);
  if (res.type !== 'signed') throw new Error(`Unexpected sign response: ${JSON.stringify(res).slice(0, 120)}`);
  const signerHex = String(res.signer || '').trim().toLowerCase();
  const sigHex = String(res.sig || '').trim().toLowerCase();
  if (!signerHex || !sigHex) throw new Error('Signing failed (missing signer/sig)');
  return { signerHex, sigHex };
}

async function signSwapEnvelope(sc, unsignedEnvelope) {
  const { signerHex, sigHex } = await signViaBridge(sc, unsignedEnvelope);
  const signed = attachSignature(unsignedEnvelope, { signerPubKeyHex: signerHex, sigHex });
  const v = validateSwapEnvelope(signed);
  if (!v.ok) throw new Error(`Internal error: signed envelope invalid: ${v.error}`);
  return signed;
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));

  const url = requireFlag(flags, 'url');
  const token = requireFlag(flags, 'token');
  const otcChannel = (flags.get('otc-channel') && String(flags.get('otc-channel')).trim()) || 'btc-usdt-sol-otc';

  const tradeId = (flags.get('trade-id') && String(flags.get('trade-id')).trim()) || `swap_${crypto.randomUUID()}`;

  const btcSats = parseIntFlag(flags.get('btc-sats'), 'btc-sats', 50_000);
  const usdtAmount = (flags.get('usdt-amount') && String(flags.get('usdt-amount')).trim()) || '100000000';
  const rfqValidSec = parseIntFlag(flags.get('rfq-valid-sec'), 'rfq-valid-sec', 60);

  const timeoutSec = parseIntFlag(flags.get('timeout-sec'), 'timeout-sec', 30);
  const rfqResendMs = parseIntFlag(flags.get('rfq-resend-ms'), 'rfq-resend-ms', 1200);
  const acceptResendMs = parseIntFlag(flags.get('accept-resend-ms'), 'accept-resend-ms', 1200);

  const onceExitDelayMs = parseIntFlag(flags.get('once-exit-delay-ms'), 'once-exit-delay-ms', 200);
  const once = parseBool(flags.get('once'), false);
  const debug = parseBool(flags.get('debug'), false);

  const sc = new ScBridgeClient({ url, token });
  await sc.connect();

  ensureOk(await sc.join(otcChannel), `join ${otcChannel}`);
  ensureOk(await sc.subscribe([otcChannel]), `subscribe ${otcChannel}`);

  const takerPubkey = String(sc.hello?.peer || '').trim().toLowerCase();
  if (!takerPubkey) die('SC-Bridge hello missing peer pubkey');

  const nowSec = Math.floor(Date.now() / 1000);
  const rfqUnsigned = createUnsignedEnvelope({
    v: 1,
    kind: KIND.RFQ,
    tradeId,
    body: {
      pair: PAIR.BTC_LN__USDT_SOL,
      direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
      btc_sats: btcSats,
      usdt_amount: usdtAmount,
      valid_until_unix: nowSec + rfqValidSec,
    },
  });
  const rfqId = hashUnsignedEnvelope(rfqUnsigned);
  const rfqSigned = await signSwapEnvelope(sc, rfqUnsigned);
  ensureOk(await sc.send(otcChannel, rfqSigned), 'send rfq');

  process.stdout.write(`${JSON.stringify({ type: 'ready', role: 'taker', otc_channel: otcChannel, trade_id: tradeId, rfq_id: rfqId, pubkey: takerPubkey })}\n`);

  let chosen = null; // { rfq_id, quote_id, quote }
  let joined = false;

  const deadlineMs = Date.now() + timeoutSec * 1000;

  const maybeExit = () => {
    if (!once) return;
    if (!joined) return;
    const delay = Number.isFinite(onceExitDelayMs) ? Math.max(onceExitDelayMs, 0) : 0;
    setTimeout(() => {
      sc.close();
      process.exit(0);
    }, delay);
  };

  const resendRfqTimer = setInterval(async () => {
    try {
      if (chosen) return;
      if (Date.now() > deadlineMs) return;
      ensureOk(await sc.send(otcChannel, rfqSigned), 'resend rfq');
      if (debug) process.stderr.write(`[taker] resend rfq trade_id=${tradeId}\n`);
    } catch (err) {
      if (debug) process.stderr.write(`[taker] resend rfq error: ${err?.message ?? String(err)}\n`);
    }
  }, Math.max(rfqResendMs, 200));

  let quoteAcceptSigned = null;
  const resendAcceptTimer = setInterval(async () => {
    try {
      if (!chosen) return;
      if (joined) return;
      if (Date.now() > deadlineMs) return;
      if (!quoteAcceptSigned) return;
      ensureOk(await sc.send(otcChannel, quoteAcceptSigned), 'resend quote_accept');
      if (debug) process.stderr.write(`[taker] resend quote_accept trade_id=${tradeId} quote_id=${chosen.quote_id}\n`);
    } catch (err) {
      if (debug) process.stderr.write(`[taker] resend quote_accept error: ${err?.message ?? String(err)}\n`);
    }
  }, Math.max(acceptResendMs, 200));

  const stopTimers = () => {
    clearInterval(resendRfqTimer);
    clearInterval(resendAcceptTimer);
  };

  const enforceTimeout = setInterval(() => {
    if (Date.now() <= deadlineMs) return;
    stopTimers();
    die(`Timeout waiting for OTC handshake (timeout-sec=${timeoutSec})`);
  }, 200);

  sc.on('sidechannel_message', async (evt) => {
    try {
      if (evt?.channel !== otcChannel) return;
      const msg = evt?.message;
      if (!msg || typeof msg !== 'object') return;

      if (msg.kind === KIND.QUOTE) {
        if (String(msg.trade_id) !== tradeId) return;
        const v = validateSwapEnvelope(msg);
        if (!v.ok) return;
        const quoteUnsigned = stripSignature(msg);
        const quoteId = hashUnsignedEnvelope(quoteUnsigned);
        const rfqIdGot = String(msg.body?.rfq_id || '').trim().toLowerCase();
        if (rfqIdGot !== rfqId) return;

        const validUntil = Number(msg.body?.valid_until_unix);
        const now = Math.floor(Date.now() / 1000);
        if (Number.isFinite(validUntil) && validUntil <= now) {
          if (debug) process.stderr.write(`[taker] ignore expired quote quote_id=${quoteId}\n`);
          return;
        }

        if (!chosen) {
          chosen = { rfq_id: rfqId, quote_id: quoteId, quote: msg };
          const quoteAcceptUnsigned = createUnsignedEnvelope({
            v: 1,
            kind: KIND.QUOTE_ACCEPT,
            tradeId,
            body: {
              rfq_id: rfqId,
              quote_id: quoteId,
            },
          });
          quoteAcceptSigned = await signSwapEnvelope(sc, quoteAcceptUnsigned);
          ensureOk(await sc.send(otcChannel, quoteAcceptSigned), 'send quote_accept');
          if (debug) process.stderr.write(`[taker] accepted quote trade_id=${tradeId} quote_id=${quoteId}\n`);
          process.stdout.write(`${JSON.stringify({ type: 'quote_accepted', trade_id: tradeId, rfq_id: rfqId, quote_id: quoteId })}\n`);
        }
        return;
      }

      if (msg.kind === KIND.SWAP_INVITE) {
        if (String(msg.trade_id) !== tradeId) return;
        const v = validateSwapEnvelope(msg);
        if (!v.ok) return;
        if (!chosen) return;
        if (String(msg.body?.rfq_id || '').trim().toLowerCase() !== chosen.rfq_id) return;
        if (String(msg.body?.quote_id || '').trim().toLowerCase() !== chosen.quote_id) return;

        const swapChannel = String(msg.body?.swap_channel || '').trim();
        if (!swapChannel) return;

        const invite = msg.body?.invite || null;
        const welcome = msg.body?.welcome || null;

        // Best-effort: ensure the invite is for us (defense-in-depth).
        const invitee = String(invite?.payload?.inviteePubKey || '').trim().toLowerCase();
        if (invitee && invitee !== takerPubkey) return;

        ensureOk(await sc.join(swapChannel, { invite, welcome }), `join ${swapChannel}`);
        joined = true;
        stopTimers();
        clearInterval(enforceTimeout);
        process.stdout.write(`${JSON.stringify({ type: 'swap_joined', trade_id: tradeId, swap_channel: swapChannel })}\n`);
        maybeExit();
      }
    } catch (err) {
      if (debug) process.stderr.write(`[taker] error: ${err?.message ?? String(err)}\n`);
    }
  });

  // Keep process alive.
  await new Promise(() => {});
}

main().catch((err) => die(err?.stack || err?.message || String(err)));

