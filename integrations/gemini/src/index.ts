import type { AgentDriver, RavelSession, SemanticAnalyzer, SemanticInput } from '@ravel/core';
import type { SemanticResult, Task } from '@ravel/shared';

/** Provider boundary only. No SDK, network call or credentials are required by the core. */
export interface GeminiTransport {
  runAgent(task: Task, environment: RavelSession, model: string): Promise<void>;
  analyze(input: SemanticInput, model: string): Promise<SemanticResult>;
}
export class GeminiAgentDriver implements AgentDriver {
  readonly name = 'GeminiAgentDriver';
  constructor(
    private readonly transport: GeminiTransport,
    private readonly model: string,
  ) {}
  run(task: Task, session: RavelSession) {
    return this.transport.runAgent(task, session, this.model);
  }
}
export class GeminiSemanticAnalyzer implements SemanticAnalyzer {
  readonly name = 'GeminiSemanticAnalyzer';
  constructor(
    private readonly transport: GeminiTransport,
    private readonly model: string,
  ) {}
  analyze(input: SemanticInput) {
    return this.transport.analyze(input, this.model);
  }
}
export function geminiStatus(environment: NodeJS.ProcessEnv = process.env) {
  return {
    name: 'Gemini',
    enabled: false,
    configured: Boolean(environment.GEMINI_API_KEY),
    reason: environment.GEMINI_API_KEY
      ? 'Transport not installed; scripted agents and heuristic analysis remain active.'
      : 'Optional API key absent; scripted agents and heuristic analysis remain active.',
  };
}
