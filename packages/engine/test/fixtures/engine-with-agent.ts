// A stand-in for the engine's own entry point: it installs the same
// signal handling the engine installs, then keeps one fake Pi run hanging,
// so a test can signal this process and watch the agent child stop with
// it. It prints its state folder as one JSON line before the run starts,
// and holds the process open the way the engine's serve loop does.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopAgentChildrenOnSignal } from '../../src/agent-children.js';
import { piAdapter } from '../../src/pi.js';

const FAKE_PI = fileURLToPath(new URL('./fake-pi.mjs', import.meta.url));
const GUARD = fileURLToPath(new URL('../../src/pi-guard.ts', import.meta.url));

const dir = mkdtempSync(join(tmpdir(), 'second-look-engine-with-agent-'));
writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ runs: [{ hang: true }] }));
stopAgentChildrenOnSignal();
process.stdout.write(`${JSON.stringify({ dir })}\n`);
setInterval(() => undefined, 60_000);
await piAdapter({
  command: [process.execPath, FAKE_PI],
  guardPath: GUARD,
  env: { ...process.env, FAKE_PI_DIR: dir },
  killGraceMs: 200,
}).run({ root: dir, instructions: 'Instructions.', prompt: 'Run.', timeoutMs: 60_000 });
