import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { hash, id, resourcePath } from '../domain/models.js';
import { applyEvent, emptyState, project } from '../replay/projector.js';
import { Workspace } from './workspace.js';

/** Synchronous critical sections serialize mediated operations in one Node process. */
export class Runtime extends EventEmitter {
  constructor(store, workspace, runId = null) {
    super();
    this.store = store;
    this.workspace = new Workspace(workspace);
    this.runId = runId ?? id('run');
    this.state = store.events(this.runId).reduce(applyEvent, emptyState());
  }

  emitFact(kind, payload, attemptId = null, mutation = null) {
    const attempt = attemptId ? this.state.attempts[attemptId] : null;
    const agentId = attempt?.agent_id ?? payload.agent_id ?? null;
    const agentSeq = agentId ? this.state.events.filter((e) => e.agent_id === agentId).length + 1 : null;
    const event = {
      event_id: id('event'), run_id: this.runId, runtime_seq: this.state.runtime_seq + 1,
      agent_id: agentId, task_id: attempt?.task.task_id ?? payload.task?.task_id ?? null,
      attempt_id: attemptId ?? payload.attempt_id ?? null, agent_seq: agentSeq, kind,
      wall_time: new Date().toISOString(), monotonic_time: performance.now(), command_id: null, payload,
    };
    if (payload.version) {
      payload.version.created_event_id = event.event_id;
      payload.version.creation_seq = event.runtime_seq;
    }
    this.store.append(event, mutation?.apply, mutation?.restore);
    applyEvent(this.state, event);
    this.emit('event', event);
    return event;
  }

  start(metadata = {}) {
    if (this.state.run) throw new Error('Run already started.');
    this.emitFact('RUN_START', metadata);
    return this.runId;
  }

  requireRun() {
    if (!this.state.run || this.state.run.status !== 'running') throw new Error('Run is not active.');
  }

  agent(name, adapterType = 'scripted') {
    this.requireRun();
    const agentId = id('agent');
    this.emitFact('AGENT_START', { agent_id: agentId, name, adapter_type: adapterType });
    return agentId;
  }

  attempt(agentId, name, prompt = '', taskId = null) {
    this.requireRun();
    if (!this.state.agents[agentId]) throw new Error('Unknown agent.');
    const previousTask = taskId ? this.state.tasks[taskId] : null;
    if (taskId && !previousTask) throw new Error('Unknown task.');
    const task = previousTask ?? { task_id: id('task'), run_id: this.runId, name, prompt };
    const attemptId = id('attempt');
    const attemptNumber = Object.values(this.state.attempts).filter((a) => a.task.task_id === task.task_id).length + 1;
    this.emitFact('TASK_ATTEMPT_START', { agent_id: agentId, attempt_id: attemptId, task, attempt_number: attemptNumber });
    return attemptId;
  }

  requireAttempt(attemptId) {
    this.requireRun();
    const attempt = this.state.attempts[attemptId];
    if (!attempt || attempt.status !== 'running') throw new Error('Task attempt is not active.');
    return attempt;
  }

  finishAttempt(attemptId, status = 'completed') {
    this.requireAttempt(attemptId);
    if (!['completed', 'failed', 'invalidated'].includes(status)) throw new Error('Invalid attempt status.');
    this.emitFact('TASK_ATTEMPT_END', { status }, attemptId);
  }

  snapshot(resource, initialGeneration = 1) {
    this.requireRun();
    const path = resourcePath(resource);
    if (this.state.heads[path]) return this.state.versions[this.state.heads[path]];
    if (!Number.isSafeInteger(initialGeneration) || initialGeneration < 1) throw new Error('Invalid initial generation.');
    const content = this.workspace.read(path);
    const blob = content === null ? null : this.store.putBlob(content);
    const version = { version_id: id('version'), resource_id: path, generation: initialGeneration, content_hash: blob, blob_ref: blob, producer_attempt_id: null, deleted: content === null };
    this.emitFact('RESOURCE_SNAPSHOT', { version });
    return version;
  }

  verifyWorkspace(resource, head) {
    const content = this.workspace.read(resource);
    if ((content === null ? null : hash(content)) !== head.content_hash) throw new Error(`Unmediated workspace change detected: ${resource}. Start a new run to capture it.`);
    return content;
  }

  observe(attemptId, resource) {
    this.requireAttempt(attemptId);
    const version = this.snapshot(resource);
    const content = this.verifyWorkspace(version.resource_id, version);
    this.emitFact('OBSERVE_RESOURCE', { resource_id: version.resource_id, version_id: version.version_id }, attemptId);
    return { version, content: content?.toString('utf8') ?? null };
  }

  write(attemptId, resource, content) {
    this.requireAttempt(attemptId);
    if (content !== null && typeof content !== 'string' && !Buffer.isBuffer(content)) throw new Error('Content must be text, bytes, or null for deletion.');
    const head = this.snapshot(resource);
    const before = this.verifyWorkspace(head.resource_id, head);
    const blob = content === null ? null : this.store.putBlob(content);
    if (blob === head.content_hash) {
      this.emitFact('NOOP_WRITE', { resource_id: head.resource_id, version_id: head.version_id }, attemptId);
      return head;
    }
    // Check every directly observed input against its recorded head as well.
    for (const path of Object.keys(this.state.attempts[attemptId].frontier)) this.verifyWorkspace(path, this.state.versions[this.state.heads[path]]);
    const version = { version_id: id('version'), resource_id: head.resource_id, generation: head.generation + 1, content_hash: blob, blob_ref: blob, producer_attempt_id: attemptId, deleted: content === null };
    this.emitFact(content === null ? 'DELETE_COMMIT' : 'WRITE_COMMIT', { version }, attemptId, {
      apply: () => this.workspace.write(head.resource_id, content),
      restore: () => this.workspace.write(head.resource_id, before),
    });
    return version;
  }

  assess(hazardId, assessment) {
    this.requireRun();
    if (!this.state.hazards.some((h) => h.hazard_id === hazardId)) throw new Error('Unknown hazard.');
    if (!['irrelevant', 'possible', 'likely', 'confirmed'].includes(assessment.relevance)) throw new Error('Invalid semantic relevance.');
    this.emitFact('SEMANTIC_ASSESSMENT', { ...assessment, hazard_id: hazardId });
  }

  end() {
    this.requireRun();
    if (Object.values(this.state.attempts).some((a) => a.status === 'running')) throw new Error('Finish all attempts before ending the run.');
    this.emitFact('RUN_END', {});
  }

  resume() {
    if (this.state.run?.status !== 'completed') throw new Error('Only a completed run can be resumed.');
    this.emitFact('RUN_RESUME', {});
  }

  projection(through = this.state.runtime_seq) { return project(this.store.events(this.runId, through)); }
}
