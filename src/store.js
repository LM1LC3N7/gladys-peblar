// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container): the end of a pause (429, or a 5xx), and the block after a token
// or a password refused, so a restart never asks the charger again before its
// time and never loops on a refused login. Bounded when read back: a pause
// never more than 6 h away, a block never more than the longest new-try delay.
// NO SECRET: neither the token, nor the password, nor anything derived from
// them; the block only keeps which kind of credential was refused. The file
// is readable by the container user only (0600).
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { TIMINGS } from './constants.js';

export const STATE_FILE = '/data/peblar-state.json';

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const longestBlock = TIMINGS.authBackoff.at(-1);

/**
 * The persisted state, repaired and bounded:
 * `{ pause: { until, reason } | null, block: { until, mode, failures } | null }`.
 */
export function normalizeMemory(raw, now) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const pause = data.pause && typeof data.pause === 'object' ? data.pause : {};
  const block = data.block && typeof data.block === 'object' ? data.block : {};
  const failures = Number.isInteger(block.failures) && block.failures > 0 ? block.failures : 1;
  return {
    pause:
      Number.isFinite(pause.until) && pause.until > now
        ? {
            until: Math.min(pause.until, now + TIMINGS.rateLimitMax),
            reason: pause.reason === '5xx' ? '5xx' : '429',
          }
        : null,
    block:
      Number.isFinite(block.until) && (block.mode === 'token' || block.mode === 'password')
        ? {
            // An expired block is kept (its count spaces the next tries) but no longer waits.
            until: Math.min(block.until, now + longestBlock),
            mode: block.mode,
            failures: Math.min(failures, 100),
          }
        : null,
  };
}
