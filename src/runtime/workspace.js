import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resourcePath } from '../domain/models.js';

export class Workspace {
  constructor(root) {
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
  }

  path(resource) {
    const normalized = resourcePath(resource);
    const target = resolve(this.root, normalized);
    if (!target.startsWith(this.root + sep)) throw new Error('Path escapes workspace.');
    let cursor = this.root;
    for (const component of normalized.split('/')) {
      cursor = join(cursor, component);
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Symlink resources are outside the v0 workspace contract.');
    }
    return target;
  }

  read(resource) {
    const path = this.path(resource);
    return existsSync(path) ? readFileSync(path) : null;
  }

  write(resource, bytes) {
    const path = this.path(resource);
    if (bytes === null) { rmSync(path, { force: true }); return; }
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, bytes); renameSync(temp, path); }
    finally { rmSync(temp, { force: true }); }
  }
}
