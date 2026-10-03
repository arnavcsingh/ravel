import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

function activeLease(directory: string): boolean {
  const path = join(directory, 'server.lock');
  if (!existsSync(path)) return false;
  let pid: number;
  try {
    pid = (JSON.parse(readFileSync(path, 'utf8')) as { pid: number }).pid;
  } catch {
    throw new Error('Unreadable server.lock. Inspect the data directory before restarting.');
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid server.lock process id.');
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true;
  }
}
export function acquireServerLease(directory: string): () => void {
  mkdirSync(directory, { recursive: true });
  if (activeLease(directory))
    throw new Error(
      'A Ravel server already owns this data directory. Stop it or use another RAVEL_DATA_DIR.',
    );
  const path = join(directory, 'server.lock');
  if (existsSync(path)) rmSync(path);
  writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), {
    flag: 'wx',
  });
  return () => {
    if (
      existsSync(path) &&
      (JSON.parse(readFileSync(path, 'utf8')) as { pid: number }).pid === process.pid
    )
      rmSync(path);
  };
}
export function resetDemo(directory: string, protectedDirectory = process.cwd()): string | null {
  const source = resolve(directory),
    protectedRoot = resolve(protectedDirectory);
  const relation = relative(source, protectedRoot);
  if (
    relation === '' ||
    (!relation.startsWith('..' + sep) && relation !== '..' && !relation.includes(':'))
  )
    throw new Error('Cannot reset the repository or one of its parent directories.');
  if (!existsSync(source)) return null;
  if (!existsSync(join(source, 'ravel.db')) || !existsSync(join(source, 'blobs')))
    throw new Error('Reset target is not a Ravel data directory.');
  if (activeLease(source))
    throw new Error('Stop the Ravel server before resetting its data directory.');
  const target = `${source}.saved-${new Date().toISOString().replaceAll(':', '-')}`;
  if (dirname(target) !== dirname(source))
    throw new Error('Reset backup must remain beside the data directory.');
  renameSync(source, target);
  return target;
}
