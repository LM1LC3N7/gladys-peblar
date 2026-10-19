import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PeblarClient,
  cookieOf,
  parseEvInterface,
  parseMeter,
  parseSystem,
  parseToken,
  parseUserConfig,
  retryAfterOf,
  serialOf,
} from '../src/peblar/client.js';
import { createServer } from 'node:http';
import { ERROR_KINDS, request } from '../src/peblar/http.js';
import { normalizeMemory } from '../src/store.js';
import { meter } from './fixtures/fakePeblar.js';

test('meter: mA to A, Wh to kWh, missing phases undefined', () => {
  const m = parseMeter(meter());
  assert.deepEqual(m.currents, [15.9, 16, 15.8]);
  assert.equal(m.sessionEnergy, 34.918);
  assert.equal(m.totalEnergy, 4937.323);
  const single = parseMeter({ CurrentPhase1: 100, PowerTotal: 0 });
  assert.deepEqual(single.currents, [0.1, undefined, undefined]);
  assert.deepEqual(single.voltages, [undefined, undefined, undefined]);
});

test('hostile answers: wrong types are undefined, never a default', () => {
  const e = parseEvInterface({ ChargeCurrentLimit: '16000', CpState: 'toString', Force1Phase: 1 });
  assert.equal(e.limit, undefined);
  assert.equal(e.state, 'unknown');
  assert.equal(e.singlePhase, undefined);
  assert.equal(parseEvInterface({ ChargeCurrentLimit: -1 }).limit, undefined);
  const s = parseSystem(
    JSON.parse('{"__proto__": {"ProductSn": "x"}, "ActiveErrorCodes": [1, "2", 3]}'),
  );
  assert.equal(s.serial, undefined);
  assert.deepEqual(s.errors, [1, 3]);
  for (const bad of [null, [], 'text', 12]) {
    assert.throws(
      () => parseMeter(bad),
      (err) => err.kind === ERROR_KINDS.PROTOCOL,
    );
  }
  assert.equal(parseUserConfig({ CurrentCtrlFixedChargeCurrentLimit: 5 }).installMax, undefined);
  assert.equal(parseUserConfig({ CurrentCtrlFixedChargeCurrentLimit: 20 }).installMax, 20);
  assert.equal(
    parseUserConfig({ UserDefinedChargeLimitCurrent: 10 }).installMax,
    undefined,
    'never the user-defined limit (it may mirror the REST limit)',
  );
});

test('serials, tokens, cookies', () => {
  assert.equal(serialOf('23-45-ABC-678'), '23-45-abc-678');
  assert.equal(serialOf('../etc'), undefined);
  assert.equal(serialOf('a:b'), undefined);
  assert.throws(() => parseToken({ ApiToken: 'short' }));
  assert.equal(parseToken({ ApiToken: 'x'.repeat(64) }), 'x'.repeat(64));
  assert.equal(cookieOf(['sid=abc; Path=/; HttpOnly', 'other=1']), 'sid=abc; other=1');
  assert.equal(cookieOf(['bad cookie']), undefined);
  assert.equal(cookieOf(undefined), undefined);
});

test('Retry-After in seconds or as a date', () => {
  assert.equal(retryAfterOf('120'), 120_000);
  assert.equal(retryAfterOf(new Date(10_000).toUTCString(), 0), 10_000);
  assert.equal(retryAfterOf('soon'), undefined);
});

test('statuses: 401/403 auth, 429 rate limited, others http; the body never kept', async () => {
  for (const [status, kind] of [
    [401, ERROR_KINDS.AUTH],
    [403, ERROR_KINDS.AUTH],
    [429, ERROR_KINDS.RATE_LIMITED],
    [500, ERROR_KINDS.HTTP],
  ]) {
    const client = new PeblarClient({
      transport: async () => ({ status, headers: {}, body: 'secret-echo' }),
    });
    await assert.rejects(
      client.rest({ host: 'h', port: 80 }, 't', '/x', { timeoutMs: 100 }),
      (err) => err.kind === kind && !err.message.includes('secret-echo'),
    );
  }
});

test('a command too late is never sent; a bad limit is never sent', async () => {
  let calls = 0;
  const client = new PeblarClient({
    transport: async () => {
      calls += 1;
      return { status: 200, headers: {}, body: '' };
    },
    now: () => 1_000,
  });
  await assert.rejects(
    client.setLimit({ host: 'h', port: 80 }, 't', 6000, { startBy: 999, timeoutMs: 100 }),
    (err) => err.kind === ERROR_KINDS.LATE,
  );
  await assert.rejects(
    client.setLimit({ host: 'h', port: 80 }, 't', 6.5, { startBy: 2_000, timeoutMs: 100 }),
    (err) => err.notSent,
  );
  assert.equal(calls, 0);
});

test('the real transport against a loopback server: headers, body, size bound', async (t) => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    if (req.url === '/big') {
      res.end('x'.repeat(70 * 1024));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ PhaseCount: 3 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = { host: '127.0.0.1', port: server.address().port };
  const client = new PeblarClient({ transport: request });
  const data = await client.rest(address, 'tok', '/api/wlac/v1/system', { timeoutMs: 2000 });
  assert.equal(data.PhaseCount, 3);
  assert.equal(seen[0].authorization, 'tok');
  await assert.rejects(
    client.rest(address, 'tok', '/big', { timeoutMs: 2000 }),
    (err) => err.kind === ERROR_KINDS.PROTOCOL,
  );
  server.close();
  await assert.rejects(
    request({ ...address, path: '/', timeoutMs: 500 }),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE,
  );
});

test('the memory in /data is repaired and bounded, and holds no secret', () => {
  const now = 1_000_000;
  const memory = normalizeMemory(
    {
      pause: { until: now + 999 * 3_600_000, reason: 'x' },
      block: { until: now + 999 * 3_600_000, mode: 'token', failures: 3, token: 'leak' },
    },
    now,
  );
  assert.equal(memory.pause.until, now + 6 * 3_600_000);
  assert.equal(memory.pause.reason, '429');
  assert.equal(memory.block.until, now + 6 * 3_600_000);
  assert.ok(!JSON.stringify(memory).includes('leak'));
  assert.deepEqual(normalizeMemory('garbage', now), { pause: null, block: null });
});
