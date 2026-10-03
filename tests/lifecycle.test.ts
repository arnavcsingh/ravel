import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireServerLease, resetDemo } from '../apps/server/src/lifecycle';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function root() {
  const value = mkdtempSync(join(tmpdir(), 'ravel-lifecycle-'));
  roots.push(value);
  return value;
}
it('allows one CLI server owner and releases its lease on shutdown', () => {
  const directory = root();
  const release = acquireServerLease(directory);
  expect(() => acquireServerLease(directory)).toThrow('already owns');
  release();
  expect(existsSync(join(directory, 'server.lock'))).toBe(false);
  const second = acquireServerLease(directory);
  second();
});
it('reset preserves database, blobs and workspace in a sibling backup', () => {
  const parent = root(),
    directory = join(parent, 'data');
  mkdirSync(join(directory, 'blobs'), { recursive: true });
  writeFileSync(join(directory, 'ravel.db'), 'saved history');
  const target = resetDemo(directory)!;
  expect(target.startsWith(directory + '.saved-')).toBe(true);
  expect(readFileSync(join(target, 'ravel.db'), 'utf8')).toBe('saved history');
  expect(existsSync(directory)).toBe(false);
});
it('refuses active, unrelated, and ancestor directories when resetting', () => {
  const directory = root();
  expect(() => resetDemo(directory)).toThrow('not a Ravel');
  mkdirSync(join(directory, 'blobs'));
  writeFileSync(join(directory, 'ravel.db'), 'history');
  const release = acquireServerLease(directory);
  expect(() => resetDemo(directory)).toThrow('Stop');
  release();
  expect(() => resetDemo(directory, join(directory, 'child'))).toThrow('parent');
  expect(() => resetDemo(directory, directory)).toThrow('repository');
});
