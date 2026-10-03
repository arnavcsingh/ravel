import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DebuggerProjector,
  HeuristicSemanticAnalyzer,
  RavelStore,
  RunCoordinator,
} from '@ravel/core';
import { DemoRequestSchema, SequenceQuerySchema, type LiveProjectionSink } from '@ravel/shared';
import { prepareDemo, repairDemo, type DemoController } from '@ravel/demo';
import { geminiStatus } from '@ravel/gemini';
import { spacetimeStatus } from '@ravel/spacetime';
import { fetchStatus } from '@ravel/fetch';
import { SseLiveProjectionSink } from './sse';

export interface AppOptions {
  directory?: string;
  seed?: boolean;
  staticRoot?: string;
  sink?: LiveProjectionSink;
}
export async function createApp(options: AppOptions = {}) {
  const directory = resolve(options.directory ?? '.ravel/v2'),
    store = new RavelStore(directory),
    projector = new DebuggerProjector(store);
  const stream = new SseLiveProjectionSink(),
    sink = options.sink;
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const root = resolve(directory, 'workspaces'),
    controllers = new Map<string, DemoController>(),
    coordinators = new Map<string, RunCoordinator>(),
    jobs = new Set<Promise<void>>(),
    repairing = new Set<string>();
  let starting = false;
  const publish = (runId: string, runtimeSeq: number, kind: string) => {
    const update = { runId, runtimeSeq, kind };
    stream.publish(update);
    try {
      sink?.publish(update);
    } catch (error) {
      app.log.warn({ err: error }, 'Optional projection sink disabled for this update');
    }
  };
  function attach(coordinator: RunCoordinator) {
    coordinators.set(coordinator.runId, coordinator);
    coordinator.on('event', (e) => publish(e.runId, e.runtimeSeq, e.kind));
  }
  async function startDemo(request: { mode: 'observe' | 'guard'; interactive: boolean }) {
    if (
      starting ||
      [...controllers.values()].some((c) => ['running', 'held', 'ready'].includes(c.phase))
    )
      throw Object.assign(new Error('A demo is already active.'), { statusCode: 409 });
    starting = true;
    let controller: DemoController;
    try {
      controller = await prepareDemo(store, root, request);
    } finally {
      starting = false;
    }
    controllers.set(controller.coordinator.runId, controller);
    attach(controller.coordinator);
    const job = controller
      .execute()
      .catch((error) => {
        publish(controller.coordinator.runId, controller.coordinator.state.seq, 'DEMO_FAILED');
        app.log.error(error);
      })
      .finally(() => {
        jobs.delete(job);
        publish(controller.coordinator.runId, controller.coordinator.state.seq, 'DEMO_FINISHED');
      });
    jobs.add(job);
    return controller;
  }
  function coordinatorFor(runId: string) {
    let coordinator = coordinators.get(runId);
    if (!coordinator) {
      const state = projector.state(runId),
        workspace = resolve(state.run!.workspace);
      if (!workspace.startsWith(root + sep))
        throw new Error('Run workspace is outside the managed directory.');
      coordinator = new RunCoordinator(store, workspace, runId);
      attach(coordinator);
    }
    return coordinator;
  }
  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : 'Unexpected server error.';
    const statusCode =
      (error as { statusCode?: number }).statusCode ?? (/not found/i.test(message) ? 404 : 400);
    reply.code(statusCode).send({ error: message });
  });
  app.addHook('onRequest', async (request, reply) => {
    if (
      request.method === 'POST' &&
      request.headers.origin &&
      request.headers.origin !== `http://${request.headers.host}`
    )
      return reply.code(403).send({ error: 'Cross-origin mutation is not allowed.' });
  });
  app.get('/api/health', async () => ({
    status: 'ok',
    version: '0.2.0',
    integrations: [geminiStatus(), spacetimeStatus(), fetchStatus()],
  }));
  app.get('/api/runs', async () => store.runs());
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/debugger', async (request) =>
    projector.snapshot(request.params.runId, SequenceQuerySchema.parse(request.query).seq),
  );
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/events', async (request) => {
    projector.state(request.params.runId);
    return store.events(request.params.runId, SequenceQuerySchema.parse(request.query).seq);
  });
  app.get<{ Params: { hazardId: string } }>('/api/hazards/:hazardId', async (request) =>
    projector.hazard(request.params.hazardId, SequenceQuerySchema.parse(request.query).seq),
  );
  app.get<{ Params: { hazardId: string } }>('/api/hazards/:hazardId/replay', async (request) =>
    projector.replayPlan(request.params.hazardId),
  );
  app.get<{ Params: { versionId: string } }>('/api/versions/:versionId/content', async (request) =>
    projector.version(request.params.versionId),
  );
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/stream', (request, reply) => {
    const state = projector.state(request.params.runId);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    stream.subscribe(request.params.runId, reply.raw);
    const last = Number(request.headers['last-event-id'] ?? state.seq);
    if (Number.isSafeInteger(last) && last >= 0)
      for (const event of store.events(request.params.runId).filter((e) => e.runtimeSeq > last))
        reply.raw.write(
          stream.frame({ runId: event.runId, runtimeSeq: event.runtimeSeq, kind: event.kind }),
        );
    reply.raw.write(
      stream.frame({ runId: state.run!.id, runtimeSeq: state.seq, kind: 'CONNECTED' }),
    );
  });
  app.post('/api/demo', async (request, reply) => {
    const controller = await startDemo(DemoRequestSchema.parse(request.body ?? {}));
    return reply.code(201).send({ runId: controller.coordinator.runId });
  });
  app.get<{ Params: { runId: string } }>('/api/runs/:runId/demo', async (request) => {
    const state = projector.state(request.params.runId),
      controller = controllers.get(request.params.runId);
    return {
      phase: controller?.phase ?? (state.run!.status === 'completed' ? 'completed' : 'interrupted'),
      error: controller?.error ?? null,
      canRelease: controller?.phase === 'held' && !controller.released,
      workspaceError: coordinators.get(request.params.runId)?.workspaceError ?? null,
    };
  });
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/release', async (request) => {
    const controller = controllers.get(request.params.runId);
    if (!controller) throw new Error('Active demo not found.');
    controller.release();
    return { released: true };
  });
  app.post<{ Params: { runId: string } }>('/api/runs/:runId/reconstruct', async (request) => {
    await coordinatorFor(request.params.runId).reconstructWorkspace();
    return { reconstructed: true };
  });
  app.post<{ Params: { hazardId: string } }>('/api/hazards/:hazardId/analyze', async (request) => {
    const detail = projector.hazard(request.params.hazardId);
    const result = await new HeuristicSemanticAnalyzer().analyze({
      observed: detail.observedContent,
      current: detail.currentContent,
      consumer: detail.consumerContent,
      task: detail.taskName,
      resourceId: detail.observed.resourceId,
    });
    await coordinatorFor(detail.runId).assess(detail.id, result);
    return projector.hazard(detail.id);
  });
  app.post<{ Params: { hazardId: string } }>('/api/hazards/:hazardId/repair', async (request) => {
    const detail = projector.hazard(request.params.hazardId);
    if (repairing.has(detail.runId)) return { repairing: true };
    repairing.add(detail.runId);
    try {
      await repairDemo(coordinatorFor(detail.runId));
      return projector.snapshot(detail.runId);
    } finally {
      repairing.delete(detail.runId);
    }
  });
  const staticRoot =
    options.staticRoot ?? fileURLToPath(new URL('../../web/dist/', import.meta.url));
  if (existsSync(join(staticRoot, 'index.html')))
    await app.register(fastifyStatic, {
      root: resolve(staticRoot),
      prefix: '/',
      index: 'index.html',
    });
  app.addHook('onClose', async () => {
    stream.close();
    sink?.close();
    for (const controller of controllers.values())
      if (controller.phase === 'held') controller.release();
    await Promise.allSettled([...jobs]);
    for (const coordinator of coordinators.values()) coordinator.close();
    store.close();
  });
  if (options.seed !== false && store.runs().length === 0) {
    const controller = await startDemo({ mode: 'observe', interactive: false });
    await Promise.all([...jobs]);
    if (controller.phase === 'failed') throw new Error(controller.error!);
  }
  return { app, store, projector, controllers };
}
