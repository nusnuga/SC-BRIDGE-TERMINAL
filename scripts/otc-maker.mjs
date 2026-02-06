#!/usr/bin/env node
import process from 'node:process';

import { ScBridgeClient } from '../src/sc-bridge/client.js';
import { createUnsignedEnvelope, attachSignature } from '../src/protocol/signedMessage.js';
import { KIND, ASSET, PAIR } from '../src/swap/constants.js';
import { validateSwapEnvelope } from '../src/swap/schema.js';
import { hashUnsignedEnvelope } from '../src/swap/hash.js';
import { normalizeInvitePayload, normalizeWelcomePayload, createSignedInvite } from '../src/sidechannel/capabilities.js';

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
  const swapChannelTemplate =
    (flags.get('swap-channel-template') && String(flags.get('swap-channel-template')).trim()) || 'swap:{trade_id}';
  const quoteValidSec = parseIntFlag(flags.get('quote-valid-sec'), 'quote-valid-sec', 60);
  const inviteTtlSec = parseIntFlag(flags.get('invite-ttl-sec'), 'invite-ttl-sec', 7 * 24 * 3600);
  const onceExitDelayMs = parseIntFlag(flags.get('once-exit-delay-ms'), 'once-exit-delay-ms', 750);
  const once = parseBool(flags.get('once'), false);
  const debug = parseBool(flags.get('debug'), false);

  const sc = new ScBridgeClient({ url, token });
  await sc.connect();
  ensureOk(await sc.join(otcChannel), `join ${otcChannel}`);
  ensureOk(await sc.subscribe([otcChannel]), `subscribe ${otcChannel}`);

  const makerPubkey = String(sc.hello?.peer || '').trim().toLowerCase();
  if (!makerPubkey) die('SC-Bridge hello missing peer pubkey');

  const quotes = new Map(); // quote_id -> { rfq_id, trade_id }

  let done = false;

  const maybeExit = () => {
    if (!once) return;
    if (!done) return;
    const delay = Number.isFinite(onceExitDelayMs) ? Math.max(onceExitDelayMs, 0) : 0;
    setTimeout(() => {
      sc.close();
      process.exit(0);
    }, delay);
  };

  sc.on('sidechannel_message', async (evt) => {
    try {
      if (evt?.channel !== otcChannel) return;
      const msg = evt?.message;
      if (!msg || typeof msg !== 'object') return;

      if (msg.kind === KIND.RFQ) {
        const v = validateSwapEnvelope(msg);
        if (!v.ok) return;
        const rfqUnsigned = stripSignature(msg);
        const rfqId = hashUnsignedEnvelope(rfqUnsigned);

        if (msg.body?.valid_until_unix !== undefined) {
          const nowSec = Math.floor(Date.now() / 1000);
          if (Number(msg.body.valid_until_unix) <= nowSec) {
            if (debug) process.stderr.write(`[maker] skip expired rfq trade_id=${msg.trade_id} rfq_id=${rfqId}\n`);
            return;
          }
        }

        // Quote "at requested terms" for now (policy comes later).
        const nowSec = Math.floor(Date.now() / 1000);
        const quoteUnsigned = createUnsignedEnvelope({
          v: 1,
          kind: KIND.QUOTE,
          tradeId: String(msg.trade_id),
          body: {
            rfq_id: rfqId,
            pair: PAIR.BTC_LN__USDT_SOL,
            direction: `${ASSET.BTC_LN}->${ASSET.USDT_SOL}`,
            btc_sats: msg.body.btc_sats,
            usdt_amount: msg.body.usdt_amount,
            valid_until_unix: nowSec + quoteValidSec,
          },
        });
        const quoteId = hashUnsignedEnvelope(quoteUnsigned);
        const signed = await signSwapEnvelope(sc, quoteUnsigned);
        const sent = ensureOk(await sc.send(otcChannel, signed), 'send quote');
        if (debug) process.stderr.write(`[maker] quoted trade_id=${msg.trade_id} rfq_id=${rfqId} quote_id=${quoteId} sent=${sent.type}\n`);
        quotes.set(quoteId, { rfq_id: rfqId, trade_id: String(msg.trade_id) });
        return;
      }

      if (msg.kind === KIND.QUOTE_ACCEPT) {
        const v = validateSwapEnvelope(msg);
        if (!v.ok) return;
        const quoteId = String(msg.body.quote_id || '').trim().toLowerCase();
        const rfqId = String(msg.body.rfq_id || '').trim().toLowerCase();
        const known = quotes.get(quoteId);
        if (!known) return;
        if (known.rfq_id !== rfqId) return;

        const tradeId = String(msg.trade_id);
        const swapChannel = swapChannelTemplate.replaceAll('{trade_id}', tradeId);
        const inviteePubKey = String(msg.signer || '').trim().toLowerCase();
        if (!inviteePubKey) return;

        // Build welcome + invite signed by this peer (SC-Bridge signing).
        const welcomePayload = normalizeWelcomePayload({
          channel: swapChannel,
          ownerPubKey: makerPubkey,
          text: `swap ${tradeId}`,
          issuedAt: Date.now(),
          version: 1,
        });
        const { sigHex: welcomeSig } = await signViaBridge(sc, welcomePayload);
        const welcome = { payload: welcomePayload, sig: welcomeSig };

        const issuedAt = Date.now();
        const invitePayload = normalizeInvitePayload({
          channel: swapChannel,
          inviteePubKey,
          inviterPubKey: makerPubkey,
          inviterAddress: null,
          issuedAt,
          expiresAt: issuedAt + inviteTtlSec * 1000,
          nonce: Math.random().toString(36).slice(2, 10),
          version: 1,
        });
        const { sigHex: inviteSig } = await signViaBridge(sc, invitePayload);
        const invite = createSignedInvite(invitePayload, () => inviteSig, { welcome });

        const swapInviteUnsigned = createUnsignedEnvelope({
          v: 1,
          kind: KIND.SWAP_INVITE,
          tradeId,
          body: {
            rfq_id: rfqId,
            quote_id: quoteId,
            swap_channel: swapChannel,
            owner_pubkey: makerPubkey,
            invite,
            welcome,
          },
        });
        const swapInviteSigned = await signSwapEnvelope(sc, swapInviteUnsigned);
        ensureOk(await sc.send(otcChannel, swapInviteSigned), 'send swap_invite');
        ensureOk(await sc.join(swapChannel, { welcome }), `join ${swapChannel}`);
        done = true;

        process.stdout.write(`${JSON.stringify({ type: 'swap_invite_sent', trade_id: tradeId, rfq_id: rfqId, quote_id: quoteId, swap_channel: swapChannel })}\n`);
        maybeExit();
      }
    } catch (err) {
      if (debug) process.stderr.write(`[maker] error: ${err?.message ?? String(err)}\n`);
    }
  });

  process.stdout.write(`${JSON.stringify({ type: 'ready', role: 'maker', otc_channel: otcChannel, pubkey: makerPubkey })}\n`);
  // Keep process alive.
  await new Promise(() => {});
}

main().catch((err) => die(err?.stack || err?.message || String(err)));
