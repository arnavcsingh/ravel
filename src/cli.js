import { resolve, join } from 'node:path';
import { EventStore } from './events/event-store.js';
import { prepareDemo, executeDemo } from './adapters/demo-agent.js';
import { createRavelServer } from './api/server.js';

const command = process.argv[2] ?? 'serve';
const directory = resolve(process.env.RAVEL_DATA_DIR ?? '.ravel');
if (command === 'demo') {
  const store = new EventStore(directory);
  try {
    const demo = prepareDemo(store, join(directory, 'workspaces'));
    const state = await executeDemo(demo);
    console.log(JSON.stringify({ run_id: state.run.run_id, events: state.events.length, hazards: state.hazards.length, active_blast_radius: state.active_blast_radius.map((id) => `${state.versions[id].resource_id}@${state.versions[id].generation}`), semantic_assessment: state.hazards[0].assessment }, null, 2));
  } finally { store.close(); }
} else if (command === 'serve') {
  const app = await createRavelServer({ directory });
  const port = Number(process.env.PORT ?? 4317);
  app.server.listen(port, '127.0.0.1', () => console.log(`Ravel is running at http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
} else {
  console.error('Usage: node src/cli.js [serve|demo]');
  process.exitCode = 1;
}
