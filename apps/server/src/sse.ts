import type { ServerResponse } from 'node:http';
import type { LiveProjectionSink, StreamUpdate } from '@ravel/shared';
export class SseLiveProjectionSink implements LiveProjectionSink {
  private clients = new Map<string, Set<ServerResponse>>();
  private heartbeat = setInterval(() => {
    for (const clients of this.clients.values())
      for (const client of clients) client.write(': heartbeat\n\n');
  }, 15000);
  constructor() {
    this.heartbeat.unref();
  }
  subscribe(runId: string, response: ServerResponse): () => void {
    if (!this.clients.has(runId)) this.clients.set(runId, new Set());
    this.clients.get(runId)!.add(response);
    const remove = () => {
      this.clients.get(runId)?.delete(response);
      if (!this.clients.get(runId)?.size) this.clients.delete(runId);
    };
    response.on('close', remove);
    response.write(': connected\n\n');
    return remove;
  }
  frame(update: StreamUpdate): string {
    return `id: ${update.runtimeSeq}\nevent: update\ndata: ${JSON.stringify(update)}\n\n`;
  }
  publish(update: StreamUpdate): void {
    for (const client of this.clients.get(update.runId) ?? [])
      if (!client.destroyed) client.write(this.frame(update));
  }
  close(): void {
    clearInterval(this.heartbeat);
    for (const clients of this.clients.values()) for (const client of clients) client.end();
    this.clients.clear();
  }
}
