import { createHash, randomUUID } from 'node:crypto';
export const id = () => randomUUID();
export const hash = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
export const stableId = (...parts: string[]) => {
  const h = hash(parts.join('\0'));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
export function resourcePath(input: string): string {
  if (typeof input !== 'string' || !input || /[\0:]/.test(input))
    throw new Error('A repository-relative resource path is required.');
  const path = input.replaceAll('\\', '/');
  if (
    path.startsWith('/') ||
    path.split('/').some((part) => part === '..' || ['.git', '.ravel'].includes(part.toLowerCase()))
  )
    throw new Error('Resource path escapes the allowed workspace.');
  if (
    process.platform === 'win32' &&
    path
      .split('/')
      .some(
        (part) =>
          part !== '.' &&
          (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),
      )
  )
    throw new Error('Unsupported Windows resource path.');
  const normalized = path
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/');
  if (!normalized) throw new Error('A resource file path is required.');
  return normalized;
}
