/** Optional remote inspector consumes Ravel's HTTP API; it never enters core. */
export interface InspectorAgent {
  inspectRun(runId: string): Promise<unknown>;
  explainHazard(hazardId: string): Promise<unknown>;
  requestReplay(hazardId: string): Promise<unknown>;
}
export function fetchStatus(environment: NodeJS.ProcessEnv = process.env) {
  return {
    name: 'Fetch',
    enabled: false,
    configured: Boolean(environment.ASI_ONE_API_KEY),
    reason: 'Optional inspector transport is not installed.',
  };
}
