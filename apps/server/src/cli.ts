import 'dotenv/config';
import { createApp } from './app';
import { resolve } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { acquireServerLease, resetDemo } from './lifecycle';

const directory = resolve(process.env.RAVEL_DATA_DIR ?? '.ravel/v2');
if (process.argv.includes('reset')) {
  // Preserve the entire previous database, blobs, and demo workspaces for recovery.
  const target = resetDemo(directory);
  if (target) console.log(`Saved previous demo state at ${target}`);
  console.log('Demo reset. Run pnpm demo to initialize a new trace.');
} else {
  const releaseLease = acquireServerLease(directory);
  let service;
  try {
    service = await createApp({ directory });
  } catch (error) {
    releaseLease();
    throw error;
  }
  const { app } = service;
  app.addHook('onClose', async () => releaseLease());
  if (process.argv.includes('--dev')) {
    const vite = await createViteServer({
      configFile: resolve('apps/web/vite.config.ts'),
      configLoader: 'runner',
      server: { middlewareMode: true },
    });
    app.addHook('onRequest', (request, reply, done) => {
      if (request.url.startsWith('/api/')) {
        done();
        return;
      }
      vite.middlewares(request.raw, reply.raw, done);
    });
    app.addHook('onClose', async () => vite.close());
  }
  const port = Number(process.env.PORT ?? 4317);
  try {
    await app.listen({ port, host: '127.0.0.1' });
    console.log(`Ravel v0.2 is running at http://127.0.0.1:${port}`);
  } catch (error) {
    await app.close();
    throw error;
  }
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, async () => {
      await app.close();
      process.exit(0);
    });
}
