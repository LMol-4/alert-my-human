// Packs the library, installs the tarball into a fresh project, and checks the
// documented imports work with no extra dependencies. Sends nothing real.
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'alert-my-human-'));
const run = (command, cwd = dir) => execSync(command, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString();

try {
  run(`pnpm pack --pack-destination "${dir}"`, process.cwd());
  const tarball = readdirSync(dir).find((file) => file.endsWith('.tgz'));
  writeFileSync(join(dir, 'package.json'), '{ "name": "consumer", "private": true }');
  run(`npm install --no-audit --no-fund ./${tarball}`);
  assert.deepEqual(readdirSync(join(dir, 'node_modules')).filter((name) => !name.startsWith('.')), ['alert-my-human']);

  const check = `
    const fake = { async send() { return { id: 'fake-1' }; } };
    const alerts = createAlerter({ destinations: { phone: fake } });
    const { results } = await alerts.send({ destinations: ['phone'], title: 'Export complete', message: 'Your file is ready.' });
    if (results[0].outcome !== 'accepted' || results[0].providerId !== 'fake-1') throw new Error(JSON.stringify(results));
    if (typeof telegram !== 'function' || typeof destinationsFromEnv !== 'function') throw new Error('missing exports');
  `;
  writeFileSync(join(dir, 'esm.mjs'), `import { createAlerter, telegram, destinationsFromEnv } from 'alert-my-human';\n${check}`);
  writeFileSync(join(dir, 'cjs.cjs'), `const { createAlerter, telegram, destinationsFromEnv } = require('alert-my-human');\n(async () => {${check}})();`);
  run('node esm.mjs');
  run('node cjs.cjs');
  console.log('Packed library installs and imports cleanly.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
