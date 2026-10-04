// Package-manager bootstrap only. Runtime and benchmark behavior live in Go/Python.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
const bundled = join(
  homedir(),
  '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',
);
const candidates = process.env.RAVEL_PYTHON
  ? [process.env.RAVEL_PYTHON]
  : [
      ...(existsSync(resolve(root, '.ravel/sponsors-venv/Scripts/python.exe'))
        ? [resolve(root, '.ravel/sponsors-venv/Scripts/python.exe')]
        : []),
      'python3',
      'python',
      ...(existsSync(bundled) ? [bundled] : []),
    ];
const python = candidates.find((command) => {
  const probe = spawnSync(command, ['-c', 'import sys; sys.exit(sys.version_info < (3, 11))'], {
    stdio: 'ignore',
  });
  return probe.status === 0;
});
if (!python) {
  console.error('Install Python 3.11+ or set RAVEL_PYTHON to its executable.');
  process.exit(1);
}
const result = spawnSync(python, [resolve(root, 'python/manage.py'), ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
