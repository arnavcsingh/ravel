import type { RavelEvent, WriteIntent } from '@ravel/shared';

export class Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason: Error) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}
export interface MutationGate {
  beforeCommit(intent: Readonly<WriteIntent>): Promise<void>;
}
export class ControlledScheduler implements MutationGate {
  private holds = new Map<string, Deferred>();
  private listeners: {
    predicate: (event: RavelEvent) => boolean;
    deferred: Deferred<RavelEvent>;
  }[] = [];
  private history: RavelEvent[] = [];
  holdMutation(attemptId: string): void {
    if (this.holds.has(attemptId)) throw new Error('Attempt already held.');
    this.holds.set(attemptId, new Deferred());
  }
  releaseMutation(attemptId: string): void {
    const hold = this.holds.get(attemptId);
    if (!hold) throw new Error('No held mutation for this attempt.');
    this.holds.delete(attemptId);
    hold.resolve();
  }
  async beforeCommit(intent: Readonly<WriteIntent>): Promise<void> {
    await this.holds.get(intent.attemptId)?.promise;
  }
  waitForEvent(predicate: (event: RavelEvent) => boolean): Promise<RavelEvent> {
    const existing = this.history.find(predicate);
    if (existing) return Promise.resolve(existing);
    const deferred = new Deferred<RavelEvent>();
    this.listeners.push({ predicate, deferred });
    return deferred.promise;
  }
  notify(event: RavelEvent): void {
    this.history.push(event);
    const matched = this.listeners.filter((listener) => listener.predicate(event));
    this.listeners = this.listeners.filter((listener) => !matched.includes(listener));
    for (const listener of matched) listener.deferred.resolve(event);
  }
  cancel(reason = new Error('Scheduler cancelled.')): void {
    for (const hold of this.holds.values()) hold.reject(reason);
    for (const listener of this.listeners) listener.deferred.reject(reason);
    this.holds.clear();
    this.listeners = [];
  }
}
