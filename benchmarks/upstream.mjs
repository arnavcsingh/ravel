import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const action = process.argv[2] ?? 'check';
if (
  process.argv.length > 3 ||
  !['setup', 'check', 'runner-check', 'dry-run', 'smoke'].includes(action)
) {
  console.error('Usage: pnpm benchmark:upstream [setup|check|runner-check|dry-run|smoke]');
  process.exit(2);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const reports = join(root, '.ravel', 'benchmark-source', 'reports');
mkdirSync(reports, { recursive: true });
const logPath = join(reports, `${new Date().toISOString().replaceAll(':', '-')}-${action}.log`);
const log = createWriteStream(logPath);
const windows = process.platform === 'win32';
const args = windows
  ? [
      ...(process.env.RAVEL_WSL_DISTRO ? ['-d', process.env.RAVEL_WSL_DISTRO] : []),
      '--',
      'bash',
      'benchmarks/asyncodebench.sh',
      action,
    ]
  : ['benchmarks/asyncodebench.sh', action];
console.log(`AsynCodeBench ${action}; log: ${logPath}`);
const child = spawn(windows ? 'wsl.exe' : 'bash', args, {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  log.write(chunk);
});
child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
  log.write(chunk);
});
child.on('error', (error) => {
  console.error(error.message);
  log.end(error.message + '\n');
  process.exitCode = 1;
});
child.on('close', (code, signal) => {
  log.end(`\nExit: ${code ?? signal}\n`);
  process.exitCode = code ?? 1;
});
