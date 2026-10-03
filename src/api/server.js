import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EventStore } from '../events/event-store.js';
import { project, raceSlice } from '../replay/projector.js';
import { prepareDemo, executeDemo, repairDemo } from '../adapters/demo-agent.js';
import { Runtime } from '../runtime/coordinator.js';
import { join, resolve, sep } from 'node:path';

const publicDir = fileURLToPath(new URL('../../public/', import.meta.url));
const staticFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };

export async function createRavelServer({ directory = '.ravel', seed = true, demoDelay = 650 } = {}) {
  const store = new EventStore(directory);
  const clients = new Set();
  const runtimes = new Map();
  const jobs = new Set();
  const workspaceRoot = resolve(directory, 'workspaces');
  let activeDemo = null;
  const broadcast = (event) => {
    const message = `data: ${JSON.stringify({ run_id: event.run_id, runtime_seq: event.runtime_seq, kind: event.kind })}\n\n`;
    for (const client of clients) client.write(message);
  };
  function attach(runtime) { runtimes.set(runtime.runId, runtime); runtime.on('event', broadcast); }
  function stateFor(runId, seq) {
    const events = store.events(runId, seq);
    if (!events.length) { const error = new Error('Run not found.'); error.status = 404; throw error; }
    return project(events);
  }
  if (seed && store.runs().length === 0) {
    const demo = prepareDemo(store, workspaceRoot);
    attach(demo.runtime);
    await executeDemo(demo);
  }

  const server = createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      // Browser mutations must originate from this local UI. No permissive CORS.
      if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(403, { error: 'Cross-origin mutations are not allowed.' });
      if (req.method === 'GET' && staticFiles[url.pathname]) {
        const [filename, type] = staticFiles[url.pathname];
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
        res.end(readFileSync(join(publicDir, filename))); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(': connected\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/runs') {
        return json(200, store.runs().map((event) => ({ run_id: event.run_id, started_at: event.wall_time, ...event.payload })));
      }
      if (req.method === 'POST' && url.pathname === '/api/demo') {
        if (activeDemo) return json(409, { error: 'A demo is already running.' });
        const demo = prepareDemo(store, workspaceRoot);
        attach(demo.runtime);
        activeDemo = demo.runtime.runId;
        const job = executeDemo(demo, demoDelay).catch((error) => {
          broadcast({ run_id: demo.runtime.runId, runtime_seq: demo.runtime.state.runtime_seq, kind: 'DEMO_FAILED' });
          console.error('Demo failed:', error.message);
        }).finally(() => { activeDemo = null; jobs.delete(job); });
        jobs.add(job);
        return json(201, { run_id: demo.runtime.runId });
      }
      const match = /^\/api\/runs\/([^/]+)(?:\/(race|version|repair))?$/.exec(url.pathname);
      if (match) {
        const [, runId, action] = match;
        let seq = Number.MAX_SAFE_INTEGER;
        if (url.searchParams.has('seq')) {
          seq = Number(url.searchParams.get('seq'));
          if (!Number.isSafeInteger(seq) || seq < 1) return json(400, { error: 'seq must be a positive integer.' });
        }
        const state = stateFor(runId, seq);
        if (req.method === 'GET' && !action) return json(200, state);
        if (req.method === 'GET' && action === 'race') return json(200, raceSlice(state, url.searchParams.get('hazard')));
        if (req.method === 'GET' && action === 'version') {
          const version = state.versions[url.searchParams.get('id')];
          if (!version) return json(404, { error: 'Version not found.' });
          return json(200, { ...version, content: version.blob_ref ? store.getBlob(version.blob_ref).toString('utf8') : null });
        }
        if (req.method === 'POST' && action === 'repair') {
          if (activeDemo === runId) return json(409, { error: 'Wait for the demo to finish.' });
          let runtime = runtimes.get(runId);
          if (!runtime) {
            const workspace = resolve(state.run.metadata.workspace);
            if (!workspace.startsWith(workspaceRoot + sep)) return json(400, { error: 'Demo workspace is outside the managed directory.' });
            runtime = new Runtime(store, workspace, runId);
            attach(runtime);
          }
          return json(200, repairDemo(runtime));
        }
      }
      json(404, { error: 'Route not found.' });
    } catch (error) { json(error.status ?? 400, { error: error.message }); }
  });
  const heartbeat = setInterval(() => { for (const client of clients) client.write(': heartbeat\n\n'); }, 20000);
  heartbeat.unref();
  return {
    server, store,
    async close() {
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      await Promise.allSettled([...jobs]);
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}
