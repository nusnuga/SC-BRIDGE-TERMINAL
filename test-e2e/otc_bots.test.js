import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

import b4a from 'b4a';
import PeerWallet from 'trac-wallet';
import DHT from 'hyperdht';

import { ScBridgeClient } from '../src/sc-bridge/client.js';
import { createSignedWelcome, signPayloadHex, toB64Json } from '../src/sidechannel/capabilities.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

async function retry(fn, { tries = 80, delayMs = 250, label = 'retry' } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`${label} failed after ${tries} tries: ${lastErr?.message ?? String(lastErr)}`);
}

async function connectBridge(sc, label) {
  await retry(
    async () => {
      try {
        await sc.connect();
      } catch (err) {
        sc.close();
        throw err;
      }
    },
    { label, tries: 80, delayMs: 250 }
  );
}

async function mkdirp(dir) {
  await mkdir(dir, { recursive: true });
}

async function writePeerKeypair({ storesDir, storeName }) {
  const wallet = new PeerWallet();
  await wallet.ready;
  await wallet.generateKeyPair();
  const keyPairPath = path.join(storesDir, storeName, 'db', 'keypair.json');
  await mkdirp(path.dirname(keyPairPath));
  wallet.exportToFile(keyPairPath, b4a.alloc(0));
  return {
    keyPairPath,
    pubHex: b4a.toString(wallet.publicKey, 'hex'),
    secHex: b4a.toString(wallet.secretKey, 'hex'),
  };
}

function spawnPeer(args, { label }) {
  const proc = spawn('pear', ['run', '.', ...args], {
    cwd: repoRoot,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const append = (chunk) => {
    out += chunk;
    if (out.length > 20000) out = out.slice(-20000);
  };
  proc.stdout.on('data', (d) => append(String(d)));
  proc.stderr.on('data', (d) => append(String(d)));
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      // Surface in logs if a peer dies unexpectedly.
      // eslint-disable-next-line no-console
      console.error(`[e2e:${label}] peer exited code=${code}. tail:\n${out}`);
    }
  });
  return { proc, tail: () => out };
}

async function killProc(proc) {
  if (!proc || proc.killed) return;
  proc.kill('SIGINT');
  await new Promise((r) => proc.once('exit', r));
}

function spawnBot(args, { label }) {
  const proc = spawn('node', args, {
    cwd: repoRoot,
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  const appendOut = (chunk) => {
    out += chunk;
    if (out.length > 20000) out = out.slice(-20000);
  };
  const appendErr = (chunk) => {
    err += chunk;
    if (err.length > 20000) err = err.slice(-20000);
  };
  proc.stdout.on('data', (d) => appendOut(String(d)));
  proc.stderr.on('data', (d) => appendErr(String(d)));
  const wait = () =>
    new Promise((resolve, reject) => {
      proc.once('exit', (code) => {
        if (code === 0) resolve({ out, err });
        else reject(new Error(`[${label}] exit code=${code}. stderr tail:\n${err}\nstdout tail:\n${out}`));
      });
      proc.once('error', (e) => reject(e));
    });
  return { proc, wait, tail: () => ({ out, err }) };
}

function parseJsonLines(text) {
  const events = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch (_e) {}
  }
  return events;
}

test('e2e: OTC maker/taker bots negotiate and join swap channel (sidechannel invites)', async (t) => {
  const runId = crypto.randomBytes(4).toString('hex');
  const otcChannel = `btc-usdt-sol-otc-${runId}`;

  // Local DHT bootstrapper for reliability (avoid public bootstrap nodes).
  const dhtPort = 30000 + crypto.randomInt(0, 10000);
  const dht = DHT.bootstrapper(dhtPort, '127.0.0.1');
  const dhtBootstrap = `127.0.0.1:${dhtPort}`;
  t.after(async () => {
    try {
      await dht.destroy({ force: true });
    } catch (_e) {}
  });

  const storesDir = path.join(repoRoot, 'stores');
  const makerStore = `e2e-otc-maker-${runId}`;
  const takerStore = `e2e-otc-taker-${runId}`;

  const makerKeys = await writePeerKeypair({ storesDir, storeName: makerStore });
  await writePeerKeypair({ storesDir, storeName: takerStore });

  const signMakerHex = (payload) => signPayloadHex(payload, makerKeys.secHex);
  const otcWelcome = createSignedWelcome(
    { channel: otcChannel, ownerPubKey: makerKeys.pubHex, text: `otc ${runId}` },
    signMakerHex
  );
  const otcWelcomeB64 = toB64Json(otcWelcome);

  const makerToken = `token-maker-${runId}`;
  const takerToken = `token-taker-${runId}`;
  const portBase = 46000 + crypto.randomInt(0, 1000);
  const makerPort = portBase;
  const takerPort = portBase + 1;

  const makerPeer = spawnPeer(
    [
      '--peer-store-name',
      makerStore,
      '--msb',
      '0',
      '--dht-bootstrap',
      dhtBootstrap,
      '--sc-bridge',
      '1',
      '--sc-bridge-token',
      makerToken,
      '--sc-bridge-port',
      String(makerPort),
      '--sidechannels',
      otcChannel,
      '--sidechannel-pow',
      '0',
      '--sidechannel-invite-required',
      '1',
      '--sidechannel-invite-prefixes',
      'swap:',
      '--sidechannel-inviter-keys',
      makerKeys.pubHex,
      '--sidechannel-owner',
      `${otcChannel}:${makerKeys.pubHex}`,
      '--sidechannel-default-owner',
      makerKeys.pubHex,
      '--sidechannel-welcome',
      `${otcChannel}:b64:${otcWelcomeB64}`,
    ],
    { label: 'maker' }
  );

  const takerPeer = spawnPeer(
    [
      '--peer-store-name',
      takerStore,
      '--msb',
      '0',
      '--dht-bootstrap',
      dhtBootstrap,
      '--sc-bridge',
      '1',
      '--sc-bridge-token',
      takerToken,
      '--sc-bridge-port',
      String(takerPort),
      '--sidechannels',
      otcChannel,
      '--sidechannel-pow',
      '0',
      '--sidechannel-invite-required',
      '1',
      '--sidechannel-invite-prefixes',
      'swap:',
      '--sidechannel-inviter-keys',
      makerKeys.pubHex,
      '--sidechannel-owner',
      `${otcChannel}:${makerKeys.pubHex}`,
      '--sidechannel-default-owner',
      makerKeys.pubHex,
      '--sidechannel-welcome',
      `${otcChannel}:b64:${otcWelcomeB64}`,
    ],
    { label: 'taker' }
  );

  t.after(async () => {
    await killProc(takerPeer.proc);
    await killProc(makerPeer.proc);
  });

  // Wait until both SC-Bridge servers are reachable.
  const makerSc = new ScBridgeClient({ url: `ws://127.0.0.1:${makerPort}`, token: makerToken });
  const takerSc = new ScBridgeClient({ url: `ws://127.0.0.1:${takerPort}`, token: takerToken });
  await connectBridge(makerSc, 'maker sc-bridge');
  await connectBridge(takerSc, 'taker sc-bridge');
  makerSc.close();
  takerSc.close();

  const makerBot = spawnBot(
    [
      'scripts/otc-maker.mjs',
      '--url',
      `ws://127.0.0.1:${makerPort}`,
      '--token',
      makerToken,
      '--otc-channel',
      otcChannel,
      '--once',
      '1',
    ],
    { label: 'maker-bot' }
  );

  const takerBot = spawnBot(
    [
      'scripts/otc-taker.mjs',
      '--url',
      `ws://127.0.0.1:${takerPort}`,
      '--token',
      takerToken,
      '--otc-channel',
      otcChannel,
      '--once',
      '1',
      '--timeout-sec',
      '30',
    ],
    { label: 'taker-bot' }
  );

  const [makerRes, takerRes] = await Promise.all([makerBot.wait(), takerBot.wait()]);

  const makerEvents = parseJsonLines(makerRes.out);
  const takerEvents = parseJsonLines(takerRes.out);

  const inviteSent = makerEvents.find((e) => e?.type === 'swap_invite_sent');
  assert.ok(inviteSent, `maker bot did not emit swap_invite_sent. stdout tail:\n${makerRes.out}\nstderr tail:\n${makerRes.err}`);

  const joined = takerEvents.find((e) => e?.type === 'swap_joined');
  assert.ok(joined, `taker bot did not emit swap_joined. stdout tail:\n${takerRes.out}\nstderr tail:\n${takerRes.err}`);

  const swapChannel = String(joined.swap_channel || '').trim();
  assert.ok(swapChannel.startsWith('swap:'), 'swap_channel should be swap:*');

  // Assert the taker peer is actually joined to the swap channel via SC-Bridge stats.
  const takerSc2 = new ScBridgeClient({ url: `ws://127.0.0.1:${takerPort}`, token: takerToken });
  await connectBridge(takerSc2, 'taker sc-bridge (post)');
  const stats = await takerSc2.stats();
  takerSc2.close();
  assert.equal(stats.type, 'stats');
  assert.ok(Array.isArray(stats.channels));
  assert.ok(stats.channels.includes(swapChannel), `taker peer did not join ${swapChannel}. channels=${JSON.stringify(stats.channels)}`);
});

