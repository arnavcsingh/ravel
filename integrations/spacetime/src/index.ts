import type { LiveProjectionSink, StreamUpdate } from '@ravel/shared';
export class SpacetimeLiveProjectionSink implements LiveProjectionSink {
  readonly enabled = false;
  publish(_update: StreamUpdate): void {}
  close(): void {}
}
export function spacetimeStatus(environment: NodeJS.ProcessEnv = process.env) {
  return {
    name: 'SpacetimeDB',
    enabled: false,
    configured:
      environment.RAVEL_SPACETIME_ENABLED === 'true' &&
      Boolean(environment.RAVEL_SPACETIME_URI && environment.RAVEL_SPACETIME_DATABASE),
    reason: 'Optional transport placeholder; local SSE provides live updates.',
  };
}
