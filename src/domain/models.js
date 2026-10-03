import { createHash, randomUUID } from 'node:crypto';

export const id = (prefix) => `${prefix}_${randomUUID()}`;
export const hash = (content) => createHash('sha256').update(content).digest('hex');
export const Evidence = Object.freeze({ MODEL: 'MODEL_OBSERVATION', BASE: 'SAME_RESOURCE_BASE' });
export const State = Object.freeze({ CLEAN: 'CLEAN', STALE: 'STALE INPUT', DOWNSTREAM: 'DOWNSTREAM', CONFLICT: 'SEMANTIC CONFLICT' });

export function resourcePath(input) {
  if (typeof input !== 'string' || !input || input.includes('\0')) throw new Error('A repository-relative path is required.');
  const path = input.replaceAll('\\', '/');
  if (path.startsWith('/') || path.includes(':') || path.split('/').some((part) => part === '..' || part.toLowerCase() === '.git' || part.toLowerCase() === '.ravel')) {
    throw new Error('Resource paths must stay inside the workspace and outside metadata directories.');
  }
  if (process.platform === 'win32' && path.split('/').some((part) => part !== '.' && (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) {
    throw new Error('Resource paths cannot use Windows device names or trailing dots/spaces.');
  }
  const normalized = path.split('/').filter((part) => part && part !== '.').join('/');
  if (!normalized) throw new Error('A file path is required.');
  return normalized;
}
