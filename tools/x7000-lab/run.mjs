// Builds one of the lab's scripts with the web app's esbuild (they import the app's protocol code) and runs it:
//   node tools/x7000-lab/run.mjs <script> [args]
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [name, ...args] = process.argv.slice(2);
if (!name) {
  console.error('usage: node tools/x7000-lab/run.mjs <script> [args]');
  process.exit(2);
}
const out = join(here, 'build', `${name}.mjs`);
const esbuild = join(here, '../../web/node_modules/.bin/esbuild');
const built = spawnSync(esbuild, [join(here, `${name}.ts`), '--bundle', '--platform=node', '--format=esm',
  '--target=node20', `--outfile=${out}`, '--log-level=warning'], { stdio: 'inherit' });
if (built.status !== 0) {
  process.exit(built.status ?? 1);
}
const run = spawnSync(process.execPath, [out, ...args], { stdio: 'inherit' });
process.exit(run.status ?? 1);
