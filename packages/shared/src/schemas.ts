import { z } from 'zod';

export const Id = z.string().min(1);
export const EvidenceSchema = z.enum([
  'MODEL_OBSERVATION',
  'SAME_RESOURCE_BASE',
  'DECLARED_COMMAND_INPUT',
  'PROCESS_READ',
  'SEMANTIC_MATCH',
]);
export const VersionStateSchema = z.enum([
  'CLEAN',
  'STALE_INPUT',
  'DOWNSTREAM',
  'SEMANTIC_CONFLICT',
]);
export const RunSchema = z.object({
  id: Id,
  name: z.string(),
  workspace: z.string(),
  scenario: z.string().nullable(),
  mode: z.enum(['observe', 'guard']),
  status: z.enum(['running', 'completed', 'failed']),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});
export const AgentSchema = z.object({
  id: Id,
  runId: Id,
  name: z.string(),
  adapter: z.string(),
  status: z.enum(['running', 'completed']),
});
export const TaskSchema = z.object({ id: Id, runId: Id, name: z.string(), prompt: z.string() });
export const AttemptSchema = z.object({
  id: Id,
  taskId: Id,
  agentId: Id,
  number: z.number().int().positive(),
  status: z.enum(['running', 'completed', 'failed', 'invalidated']),
  startedEventId: Id,
  endedEventId: Id.nullable(),
  frontier: z.record(Id),
  observedVersions: z.array(Id),
  producedVersions: z.array(Id),
});
export const VersionSchema = z
  .object({
    id: Id,
    resourceId: z.string().min(1),
    generation: z.number().int().positive(),
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    blobRef: z.string().nullable(),
    previousVersionId: Id.nullable(),
    producerAttemptId: Id.nullable(),
    createdEventId: Id,
    creationSeq: z.number().int().positive(),
    tombstone: z.boolean(),
  })
  .refine(
    (v) => v.tombstone === (v.contentHash === null) && v.contentHash === v.blobRef,
    'Version content identity is inconsistent',
  );
export const ObservationSchema = z.object({
  id: Id,
  attemptId: Id,
  versionId: Id,
  eventId: Id,
  type: z.enum(['DIRECT_READ', 'OWN_WRITE', 'SEARCH_RESULT', 'PATCH_BASE']),
});
export const EdgeSchema = z.object({
  id: Id,
  sourceVersionId: Id,
  targetVersionId: Id,
  observationId: Id,
  evidence: EvidenceSchema,
});
export const HazardSchema = z.object({
  id: Id,
  observedVersionId: Id,
  staleSinceVersionId: Id,
  validationHeadVersionId: Id,
  consumerVersionId: Id,
  observationId: Id,
  observingAgentId: Id,
  invalidatingAgentId: Id.nullable(),
  evidence: EvidenceSchema,
  detectedSeq: z.number().int().positive(),
});
export const AssessmentSchema = z.object({
  id: Id,
  hazardId: Id,
  analyzer: z.string(),
  relevance: z.enum(['IRRELEVANT', 'POSSIBLE', 'LIKELY', 'CONFLICT']),
  reason: z.string(),
  affectedElements: z.array(z.string()),
  assessedSeq: z.number().int().positive(),
});
export const IntentSchema = z.object({
  id: Id,
  attemptId: Id,
  resourceId: z.string(),
  candidateHash: z.string().nullable(),
  observationIds: z.array(Id),
  baseVersionId: Id.nullable(),
});
export const CommandSchema = z.object({ id: Id, name: z.string(), inputVersionIds: z.array(Id) });

const envelope = {
  id: Id,
  runId: Id,
  runtimeSeq: z.number().int().positive(),
  agentId: Id.nullable(),
  taskId: Id.nullable(),
  attemptId: Id.nullable(),
  agentSeq: z.number().int().positive().nullable(),
  wallTime: z.string(),
  monotonicTime: z.number(),
  commandId: Id.nullable(),
};
const fact = <K extends string, S extends z.ZodTypeAny>(kind: K, payload: S) =>
  z.object({ ...envelope, kind: z.literal(kind), payload });
export const EventSchema = z.discriminatedUnion('kind', [
  fact('RUN_START', RunSchema),
  fact('RUN_END', z.object({ status: z.enum(['completed', 'failed']) })),
  fact('RUN_RESUME', z.object({})),
  fact('AGENT_START', AgentSchema),
  fact('AGENT_END', z.object({ agentId: Id })),
  fact('TASK_ATTEMPT_START', z.object({ task: TaskSchema, attempt: AttemptSchema })),
  fact('TASK_ATTEMPT_END', z.object({ status: z.enum(['completed', 'failed', 'invalidated']) })),
  fact('RESOURCE_SNAPSHOT', z.object({ version: VersionSchema })),
  fact('OBSERVE_RESOURCE', z.object({ observation: ObservationSchema })),
  fact(
    'SEARCH_RESULT',
    z.object({
      query: z.string(),
      observations: z.array(ObservationSchema),
      matches: z.array(
        z.object({
          resourceId: z.string(),
          versionId: Id,
          line: z.number().int(),
          text: z.string(),
        }),
      ),
    }),
  ),
  fact('LIST_RESOURCES', z.object({ resources: z.array(z.string()) })),
  fact('WRITE_INTENT', IntentSchema),
  fact(
    'WRITE_COMMIT',
    z.object({
      version: VersionSchema,
      observationIds: z.array(Id),
      observation: ObservationSchema,
      intentId: Id,
    }),
  ),
  fact(
    'DELETE_COMMIT',
    z.object({
      version: VersionSchema,
      observationIds: z.array(Id),
      observation: ObservationSchema,
      intentId: Id,
    }),
  ),
  fact('NOOP_WRITE', z.object({ observation: ObservationSchema, intentId: Id })),
  fact(
    'WRITE_REJECTED',
    z.object({ intentId: Id, staleObservationIds: z.array(Id), reason: z.string() }),
  ),
  fact('COMMAND_START', CommandSchema),
  fact(
    'COMMAND_END',
    z.object({ exitCode: z.number().int(), name: z.string(), durationMs: z.number() }),
  ),
  fact(
    'TOOL_RESULT',
    z.object({ output: z.string(), inputVersionIds: z.array(Id), success: z.boolean() }),
  ),
  fact('SEMANTIC_ASSESSMENT', AssessmentSchema),
]);

export type Run = z.infer<typeof RunSchema>;
export type Agent = z.infer<typeof AgentSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Attempt = z.infer<typeof AttemptSchema>;
export type Version = z.infer<typeof VersionSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type ProvenanceEdge = z.infer<typeof EdgeSchema>;
export type Hazard = z.infer<typeof HazardSchema>;
export type Assessment = z.infer<typeof AssessmentSchema>;
export type WriteIntent = z.infer<typeof IntentSchema>;
export type RavelEvent = z.infer<typeof EventSchema>;
export type EventKind = RavelEvent['kind'];
export type VersionState = z.infer<typeof VersionStateSchema>;
export type SemanticResult = Omit<Assessment, 'id' | 'hazardId' | 'assessedSeq'>;

export const SequenceQuerySchema = z.object({ seq: z.coerce.number().int().min(1).optional() });
export const DemoRequestSchema = z.object({
  mode: z.enum(['observe', 'guard']).default('observe'),
  interactive: z.boolean().default(false),
});
