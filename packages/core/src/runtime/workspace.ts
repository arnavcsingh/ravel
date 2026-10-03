import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { id, resourcePath } from '../domain/identity';
import type { RunState } from '../domain/state';
import type { RavelStore } from '../storage/store';

export class Workspace {
  readonly root: string;
  constructor(root: string) {
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
  }
  path(resource: string): string {
    const normalized = resourcePath(resource),
      target = resolve(this.root, normalized);
    if (!target.startsWith(this.root + sep)) throw new Error('Resource escapes the workspace.');
    let cursor = this.root;
    for (const part of normalized.split('/')) {
      cursor = join(cursor, part);
      try {
        if (lstatSync(cursor).isSymbolicLink())
          throw new Error('Symlink resources are unsupported.');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return target;
  }
  read(resource: string): Buffer | null {
    const target = this.path(resource);
    return existsSync(target) ? readFileSync(target) : null;
  }
  list(): string[] {
    const result: string[] = [];
    const visit = (directory: string, prefix = '') => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (
          entry.isSymbolicLink() ||
          ['.git', '.ravel', 'node_modules'].includes(entry.name.toLowerCase())
        )
          continue;
        const path = prefix + entry.name;
        if (entry.isDirectory()) visit(join(directory, entry.name), path + '/');
        else if (entry.isFile()) result.push(resourcePath(path));
      }
    };
    visit(this.root);
    return result.sort();
  }
  write(resource: string, bytes: Buffer | null): void {
    const target = this.path(resource);
    if (bytes === null) {
      rmSync(target, { force: true });
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.${id()}.tmp`;
    try {
      writeFileSync(temporary, bytes);
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  materialize(state: RunState, store: RavelStore): void {
    for (const [path, versionId] of Object.entries(state.heads)) {
      const version = state.versions[versionId];
      if (!version) throw new Error('Missing resource head.');
      this.write(path, version.blobRef ? store.getBlob(version.blobRef) : null);
    }
  }
}
