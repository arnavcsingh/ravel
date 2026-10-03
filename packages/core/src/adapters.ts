import type { SemanticResult, Task } from '@ravel/shared';
import type { RavelSession } from './runtime/coordinator';
export interface AgentDriver {
  readonly name: string;
  run(task: Task, session: RavelSession): Promise<void>;
}
export interface SemanticInput {
  observed: string | null;
  current: string | null;
  consumer: string | null;
  task: string;
  resourceId: string;
}
export interface SemanticAnalyzer {
  readonly name: string;
  analyze(input: SemanticInput): Promise<SemanticResult>;
}
export class HeuristicSemanticAnalyzer implements SemanticAnalyzer {
  readonly name = 'heuristic-demo-v1';
  async analyze(input: SemanticInput): Promise<SemanticResult> {
    const mismatch =
      /\bid\s+INTEGER\b/i.test(input.observed ?? '') &&
      /\bid\s+UUID\b/i.test(input.current ?? '') &&
      /\bid\s*:\s*number\b/.test(input.consumer ?? '');
    return {
      analyzer: this.name,
      relevance: mismatch ? 'LIKELY' : 'POSSIBLE',
      affectedElements: mismatch ? ['User.id'] : [],
      reason: mismatch
        ? 'The schema changed the identifier from INTEGER to UUID, while the generated TypeScript interface still declares id as number. This fixture-specific heuristic identifies a likely contract mismatch.'
        : 'The observed input changed. The heuristic cannot determine whether this difference changes the meaning of the generated output.',
    };
  }
}
