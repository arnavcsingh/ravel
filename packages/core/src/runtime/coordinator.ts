import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { applyPatch as patchText } from 'diff';
import {
  EventSchema,
  type EventKind,
  type Observation,
  type RavelEvent,
  type SemanticResult,
  type Version,
  type WriteIntent,
} from '@ravel/shared';
import { id, resourcePath } from '../domain/identity';
import { cloneState, type RunState } from '../domain/state';
import { applyEvent, replay } from '../replay/reducer';
import { staleInputs } from '../detection/stale';
import { RavelStore } from '../storage/store';
import { Workspace } from './workspace';
import { Mutex } from './mutex';
import type { MutationGate } from './scheduler';

export interface CommandResult {
  output: string;
  exitCode: number;
}
export type ReadonlyCommand = (
  files: Readonly<Record<string, string | null>>,
) => CommandResult | Promise<CommandResult>;
export interface WriteResult {
  version: Version | null;
  committed: boolean;
  noop: boolean;
  rejected: boolean;
  materialized: boolean;
}
export interface CoordinatorOptions {
  gate?: MutationGate;
  commands?: Record<string, ReadonlyCommand>;
}

/** One per run. All shared-state boundaries enter this mutex; inference and gates never do. */
export class RunCoordinator extends EventEmitter {
  readonly workspace: Workspace;
  readonly runId: string;
  private current: RunState;
  private readonly lock = new Mutex();
  private readonly pending = new Map<string, WriteIntent>();
  private readonly activeCommands = new Map<string, number>();
  private closed = false;
  private materializationFailure: string | null = null;

  constructor(
    readonly store: RavelStore,
    workspace: string,
    runId: string = id(),
    readonly options: CoordinatorOptions = {},
  ) {
    super();
    this.runId = runId;
    this.workspace = new Workspace(workspace);
    this.current = replay(store.events(runId));
  }
  get state(): RunState {
    return cloneState(this.current);
  }
  get workspaceError(): string | null {
    return this.materializationFailure;
  }

  private record(
    kind: EventKind,
    payloadFactory: (eventId: string, seq: number) => unknown,
    attemptId: string | null = null,
    agentId: string | null = null,
    commandId: string | null = null,
  ): RavelEvent {
    if (this.closed) throw new Error('Coordinator is closed.');
    const attempt = attemptId ? this.current.attempts[attemptId] : null;
    const eventId = id(),
      seq = this.current.seq + 1;
    const payload = payloadFactory(eventId, seq);
    const event = EventSchema.parse({
      id: eventId,
      runId: this.runId,
      runtimeSeq: seq,
      kind,
      payload,
      attemptId:
        attemptId ??
        (kind === 'TASK_ATTEMPT_START'
          ? (payload as { attempt: { id: string } }).attempt.id
          : null),
      agentId: attempt?.agentId ?? agentId,
      taskId:
        attempt?.taskId ??
        (kind === 'TASK_ATTEMPT_START' ? (payload as { task: { id: string } }).task.id : null),
      agentSeq:
        (attempt?.agentId ?? agentId)
          ? this.current.events.filter((e) => e.agentId === (attempt?.agentId ?? agentId)).length +
            1
          : null,
      wallTime: new Date().toISOString(),
      monotonicTime: performance.now(),
      commandId,
    });
    // Reducer must validate BEFORE durable commit. Failed transactions never leak into memory.
    const candidate = applyEvent(cloneState(this.current), structuredClone(event));
    this.store.commit(event, candidate);
    this.current = candidate;
    // Observer failures must never misrepresent a committed operation as a failed commit.
    for (const listener of this.listeners('event')) {
      try {
        listener(structuredClone(event));
      } catch (error) {
        console.warn('Ravel event listener failed:', (error as Error).message);
      }
    }
    return event;
  }
  private requireRun(): void {
    if (!this.current.run || this.current.run.status !== 'running')
      throw new Error('Run is not active.');
  }
  private requireAttempt(attemptId: string) {
    this.requireRun();
    const attempt = this.current.attempts[attemptId];
    if (!attempt || attempt.status !== 'running')
      throw new Error('Attempt is not active in this run.');
    return attempt;
  }
  async start(
    name: string,
    scenario: string | null = null,
    mode: 'observe' | 'guard' = 'observe',
  ): Promise<void> {
    await this.lock.run(() => {
      if (this.current.run) throw new Error('Run already exists.');
      this.record('RUN_START', () => ({
        id: this.runId,
        name,
        workspace: this.workspace.root,
        scenario,
        mode,
        status: 'running',
        startedAt: new Date().toISOString(),
        endedAt: null,
      }));
    });
  }
  async createAgent(name: string, adapter = 'scripted'): Promise<string> {
    return this.lock.run(() => {
      this.requireRun();
      const agentId = id();
      this.record(
        'AGENT_START',
        () => ({ id: agentId, runId: this.runId, name, adapter, status: 'running' }),
        null,
        agentId,
      );
      return agentId;
    });
  }
  async createAttempt(
    agentId: string,
    name: string,
    prompt = '',
    taskId?: string,
  ): Promise<RavelSession> {
    return this.lock.run(() => {
      this.requireRun();
      if (!this.current.agents[agentId]) throw new Error('Unknown agent.');
      const task = taskId
        ? this.current.tasks[taskId]
        : { id: id(), runId: this.runId, name, prompt };
      if (!task) throw new Error('Unknown task.');
      const attemptId = id(),
        number =
          Object.values(this.current.attempts).filter((a) => a.taskId === task.id).length + 1;
      this.record(
        'TASK_ATTEMPT_START',
        (eventId) => ({
          task,
          attempt: {
            id: attemptId,
            taskId: task.id,
            agentId,
            number,
            status: 'running',
            startedEventId: eventId,
            endedEventId: null,
            frontier: {},
            observedVersions: [],
            producedVersions: [],
          },
        }),
        null,
        agentId,
      );
      return new RavelSession(this, attemptId);
    });
  }
  session(attemptId: string): RavelSession {
    this.requireAttempt(attemptId);
    return new RavelSession(this, attemptId);
  }
  private snapshotLocked(path: string, generation = 1): Version {
    this.requireRun();
    const normalized = resourcePath(path);
    const existing = this.current.heads[normalized];
    if (existing) return this.current.versions[existing];
    const bytes = this.workspace.read(normalized),
      blob = bytes === null ? null : this.store.putBlob(bytes),
      versionId = id();
    this.record('RESOURCE_SNAPSHOT', (eventId, seq) => ({
      version: {
        id: versionId,
        resourceId: normalized,
        generation,
        contentHash: blob,
        blobRef: blob,
        previousVersionId: null,
        producerAttemptId: null,
        createdEventId: eventId,
        creationSeq: seq,
        tombstone: bytes === null,
      },
    }));
    return this.current.versions[versionId];
  }
  async importResource(path: string, generation = 1): Promise<Version> {
    return this.lock.run(() => structuredClone(this.snapshotLocked(path, generation)));
  }
  async importWorkspace(): Promise<void> {
    await this.lock.run(() => {
      for (const path of this.workspace.list()) this.snapshotLocked(path);
    });
  }
  private makeObservation(
    eventId: string,
    attemptId: string,
    versionId: string,
    type: Observation['type'],
  ): Observation {
    return { id: id(), eventId, attemptId, versionId, type };
  }
  async observe(
    attemptId: string,
    path: string,
  ): Promise<{ version: Version; content: string | null }> {
    return this.lock.run(() => {
      this.requireAttempt(attemptId);
      const version = this.snapshotLocked(path);
      const content = this.store.content(version); // Immutable blob, never mutable disk contents.
      this.record(
        'OBSERVE_RESOURCE',
        (eventId) => ({
          observation: this.makeObservation(eventId, attemptId, version.id, 'DIRECT_READ'),
        }),
        attemptId,
      );
      return { version: structuredClone(version), content };
    });
  }
  async list(attemptId: string): Promise<string[]> {
    return this.lock.run(() => {
      this.requireAttempt(attemptId);
      const resources = Object.keys(this.current.heads)
        .filter((r) => !this.current.versions[this.current.heads[r]].tombstone)
        .sort();
      this.record('LIST_RESOURCES', () => ({ resources }), attemptId);
      return resources;
    });
  }
  async search(attemptId: string, query: string) {
    return this.lock.run(() => {
      this.requireAttempt(attemptId);
      if (!query || query.length > 500) throw new Error('Search query must be 1–500 characters.');
      const matches: { resourceId: string; versionId: string; line: number; text: string }[] = [];
      for (const path of Object.keys(this.current.heads).sort()) {
        const version = this.current.versions[this.current.heads[path]];
        const lines = this.store.content(version)?.split('\n') ?? [];
        lines.forEach((text, i) => {
          if (text.includes(query))
            matches.push({ resourceId: path, versionId: version.id, line: i + 1, text });
        });
      }
      this.record(
        'SEARCH_RESULT',
        (eventId) => ({
          query,
          matches,
          observations: [...new Set(matches.map((m) => m.versionId))].map((versionId) =>
            this.makeObservation(eventId, attemptId, versionId, 'SEARCH_RESULT'),
          ),
        }),
        attemptId,
      );
      return matches;
    });
  }
  async prepareWrite(
    attemptId: string,
    path: string,
    content: string | null,
    baseVersionId?: string,
  ): Promise<WriteIntent> {
    return this.lock.run(() => {
      const attempt = this.requireAttempt(attemptId),
        head = this.snapshotLocked(path);
      const candidateHash = content === null ? null : this.store.putBlob(content);
      let observations = Object.values(attempt.frontier);
      if (baseVersionId) {
        const base = this.current.versions[baseVersionId];
        const observation = [...Object.values(this.current.observations)]
          .reverse()
          .find((o) => o.attemptId === attemptId && o.versionId === baseVersionId);
        if (!base || base.resourceId !== head.resourceId || !observation)
          throw new Error(
            'Patch base must be a version this attempt observed for the same resource.',
          );
        observations = observations.filter(
          (o) =>
            this.current.versions[this.current.observations[o].versionId].resourceId !==
            head.resourceId,
        );
        observations.push(observation.id);
      }
      const intent: WriteIntent = {
        id: id(),
        attemptId,
        resourceId: head.resourceId,
        candidateHash,
        observationIds: observations,
        baseVersionId:
          baseVersionId ??
          (attempt.frontier[head.resourceId]
            ? this.current.observations[attempt.frontier[head.resourceId]].versionId
            : null),
      };
      this.record('WRITE_INTENT', () => intent, attemptId);
      this.pending.set(intent.id, structuredClone(intent));
      return structuredClone(intent);
    });
  }
  async commitWrite(intentId: string): Promise<WriteResult> {
    const pending = this.pending.get(intentId);
    if (!pending) throw new Error('Unknown or already committed pending mutation.');
    await this.options.gate?.beforeCommit(Object.freeze(structuredClone(pending)));
    return this.lock.run(() => {
      const intent = this.pending.get(intentId);
      if (!intent) throw new Error('Pending mutation already settled.');
      this.requireAttempt(intent.attemptId);
      const head = this.current.versions[this.current.heads[intent.resourceId]];
      const stale = staleInputs(this.current, intent.observationIds);
      if (this.current.run!.mode === 'guard' && stale.length) {
        this.record(
          'WRITE_REJECTED',
          () => ({
            intentId,
            staleObservationIds: stale.map((s) => s.observation.id),
            reason: 'Observed content changed before publication.',
          }),
          intent.attemptId,
        );
        this.pending.delete(intentId);
        this.record('TASK_ATTEMPT_END', () => ({ status: 'invalidated' }), intent.attemptId);
        return { version: null, committed: false, noop: false, rejected: true, materialized: true };
      }
      if (intent.candidateHash === head.contentHash) {
        this.record(
          'NOOP_WRITE',
          (eventId) => ({
            observation: this.makeObservation(eventId, intent.attemptId, head.id, 'OWN_WRITE'),
            intentId,
          }),
          intent.attemptId,
        );
        this.pending.delete(intentId);
        return {
          version: structuredClone(head),
          committed: false,
          noop: true,
          rejected: false,
          materialized: this.materializeVersion(head),
        };
      }
      const versionId = id();
      this.record(
        intent.candidateHash === null ? 'DELETE_COMMIT' : 'WRITE_COMMIT',
        (eventId, seq) => ({
          version: {
            id: versionId,
            resourceId: intent.resourceId,
            generation: head.generation + 1,
            contentHash: intent.candidateHash,
            blobRef: intent.candidateHash,
            previousVersionId: head.id,
            producerAttemptId: intent.attemptId,
            createdEventId: eventId,
            creationSeq: seq,
            tombstone: intent.candidateHash === null,
          },
          observationIds: intent.observationIds,
          observation: this.makeObservation(eventId, intent.attemptId, versionId, 'OWN_WRITE'),
          intentId,
        }),
        intent.attemptId,
      );
      this.pending.delete(intentId);
      const version = this.current.versions[versionId];
      return {
        version: structuredClone(version),
        committed: true,
        noop: false,
        rejected: false,
        materialized: this.materializeVersion(version),
      };
    });
  }
  private materializeVersion(version: Version): boolean {
    try {
      this.workspace.write(
        version.resourceId,
        version.blobRef ? this.store.getBlob(version.blobRef) : null,
      );
      return true;
    } catch (error) {
      this.materializationFailure = (error as Error).message;
      return false;
    }
  }
  async reconstructWorkspace(): Promise<void> {
    await this.lock.run(() => {
      this.workspace.materialize(this.current, this.store);
      this.materializationFailure = null;
    });
  }
  async patch(
    attemptId: string,
    path: string,
    baseVersionId: string,
    patch: string,
  ): Promise<WriteResult> {
    const base = this.current.versions[baseVersionId];
    if (!base || base.resourceId !== resourcePath(path)) throw new Error('Unknown patch base.');
    const candidate = patchText(this.store.content(base) ?? '', patch);
    if (candidate === false) throw new Error('Patch does not apply to its declared base version.');
    const intent = await this.prepareWrite(attemptId, path, candidate, baseVersionId);
    return this.commitWrite(intent.id);
  }
  async command(attemptId: string, name: string): Promise<CommandResult> {
    const handler = this.options.commands?.[name];
    if (!handler)
      throw new Error('Unknown read-only command. Arbitrary shell execution is not supported.');
    const commandId = id();
    const { files, inputVersionIds } = await this.lock.run(() => {
      this.requireAttempt(attemptId);
      const inputVersionIds = Object.values(this.current.heads),
        files = Object.fromEntries(
          inputVersionIds.map((v) => [
            this.current.versions[v].resourceId,
            this.store.content(this.current.versions[v]),
          ]),
        );
      this.record(
        'COMMAND_START',
        () => ({ id: commandId, name, inputVersionIds }),
        attemptId,
        null,
        commandId,
      );
      this.activeCommands.set(attemptId, (this.activeCommands.get(attemptId) ?? 0) + 1);
      return { files, inputVersionIds };
    });
    const started = performance.now();
    let result: CommandResult;
    try {
      result = await handler(Object.freeze(files));
    } catch (error) {
      result = { exitCode: 1, output: (error as Error).message };
    }
    await this.lock.run(() => {
      this.record(
        'COMMAND_END',
        () => ({ exitCode: result.exitCode, name, durationMs: performance.now() - started }),
        attemptId,
        null,
        commandId,
      );
      this.record(
        'TOOL_RESULT',
        () => ({ output: result.output, inputVersionIds, success: result.exitCode === 0 }),
        attemptId,
        null,
        commandId,
      );
      const remaining = (this.activeCommands.get(attemptId) ?? 1) - 1;
      if (remaining) this.activeCommands.set(attemptId, remaining);
      else this.activeCommands.delete(attemptId);
    });
    return result;
  }
  async finishAttempt(
    attemptId: string,
    status: 'completed' | 'failed' = 'completed',
  ): Promise<void> {
    await this.lock.run(() => {
      this.requireAttempt(attemptId);
      if (
        [...this.pending.values()].some((p) => p.attemptId === attemptId) ||
        this.activeCommands.has(attemptId)
      )
        throw new Error('Attempt still has pending work.');
      this.record('TASK_ATTEMPT_END', () => ({ status }), attemptId);
    });
  }
  async assess(hazardId: string, result: SemanticResult): Promise<void> {
    await this.lock.run(() => {
      this.record('SEMANTIC_ASSESSMENT', (_eventId, seq) => ({
        ...result,
        id: id(),
        hazardId,
        assessedSeq: seq,
      }));
    });
  }
  async end(): Promise<void> {
    await this.lock.run(() => {
      this.requireRun();
      if (Object.values(this.current.attempts).some((a) => a.status === 'running'))
        throw new Error('Finish all attempts before ending the run.');
      for (const agent of Object.values(this.current.agents))
        if (agent.status === 'running')
          this.record('AGENT_END', () => ({ agentId: agent.id }), null, agent.id);
      this.record('RUN_END', () => ({ status: 'completed' }));
    });
  }
  async resume(): Promise<void> {
    await this.lock.run(() => {
      if (this.current.run?.status !== 'completed')
        throw new Error('Only completed runs can resume.');
      this.record('RUN_RESUME', () => ({}));
    });
  }
  close(): void {
    this.closed = true;
    this.removeAllListeners();
  }
}

/** The bound environment given to a driver. Identity cannot vary between tool calls. */
export class RavelSession {
  constructor(
    private readonly coordinator: RunCoordinator,
    readonly attemptId: string,
  ) {}
  get identity() {
    const state = this.coordinator.state;
    const attempt = state.attempts[this.attemptId];
    return {
      runId: this.coordinator.runId,
      agentId: attempt.agentId,
      taskId: attempt.taskId,
      attemptId: this.attemptId,
    };
  }
  observeResource(path: string) {
    return this.coordinator.observe(this.attemptId, path);
  }
  async writeResource(path: string, content: string | null) {
    const intent = await this.coordinator.prepareWrite(this.attemptId, path, content);
    return this.coordinator.commitWrite(intent.id);
  }
  applyPatch(path: string, baseVersionId: string, patch: string) {
    return this.coordinator.patch(this.attemptId, path, baseVersionId, patch);
  }
  listResources() {
    return this.coordinator.list(this.attemptId);
  }
  searchRepository(query: string) {
    return this.coordinator.search(this.attemptId, query);
  }
  runCommand(name: string) {
    return this.coordinator.command(this.attemptId, name);
  }
  complete() {
    return this.coordinator.finishAttempt(this.attemptId);
  }
}
