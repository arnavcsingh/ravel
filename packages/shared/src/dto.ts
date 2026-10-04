import { z } from 'zod';
import {
  AgentSchema,
  AssessmentSchema,
  HazardSchema,
  RunSchema,
  VersionSchema,
  VersionStateSchema,
} from './schemas';

export const TimelineEventSchema = z.object({
  id: z.string(),
  runtimeSeq: z.number(),
  agentId: z.string().nullable(),
  agentName: z.string(),
  action: z.string(),
  description: z.string(),
  versionId: z.string().nullable(),
  resourceId: z.string().nullable(),
  state: VersionStateSchema,
  hazardIds: z.array(z.string()),
  attemptId: z.string().nullable().optional(),
  taskId: z.string().nullable().optional(),
  repairOf: z.string().nullable().optional(),
});
export const GraphNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  resourceId: z.string(),
  generation: z.number(),
  state: VersionStateSchema,
  currentHead: z.boolean(),
  tombstone: z.boolean(),
  x: z.number(),
  y: z.number(),
  hazardIds: z.array(z.string()),
});
export const GraphEdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  kind: z.enum(['DERIVED_FROM', 'VERSION_SUCCESSOR']),
  label: z.string(),
});
export const HazardSummarySchema = HazardSchema.extend({
  observed: VersionSchema,
  invalidating: VersionSchema,
  consumer: VersionSchema,
  observerName: z.string(),
  invalidatorName: z.string(),
  active: z.boolean(),
  historicalBlastRadius: z.array(z.string()),
  activeBlastRadius: z.array(z.string()),
  assessment: AssessmentSchema.nullable(),
});
export const StaleWindowSchema = z.object({
  hazardId: z.string(),
  agentId: z.string(),
  observedSeq: z.number(),
  startSeq: z.number(),
  endSeq: z.number(),
  resourceId: z.string(),
});
export const DebuggerSnapshotSchema = z.object({
  run: RunSchema,
  agents: z.array(AgentSchema),
  timeline: z.array(TimelineEventSchema),
  graph: z.object({ nodes: z.array(GraphNodeSchema), edges: z.array(GraphEdgeSchema) }),
  hazards: z.array(HazardSummarySchema),
  staleWindows: z.array(StaleWindowSchema),
  currentRuntimeSeq: z.number(),
  latestRuntimeSeq: z.number(),
  activeAffectedCount: z.number(),
  eventCount: z.number(),
  heads: z.record(z.string()),
  canRepair: z.boolean(),
  guard: z.object({ rejectedWrites: z.number(), retries: z.number() }),
});
export const DiffLineSchema = z.object({
  kind: z.enum(['context', 'added', 'removed']),
  text: z.string(),
});
export const HazardDetailSchema = HazardSummarySchema.extend({
  runId: z.string(),
  observedContent: z.string().nullable(),
  currentContent: z.string().nullable(),
  consumerContent: z.string().nullable(),
  validationHead: VersionSchema,
  diff: z.array(DiffLineSchema),
  observationSeq: z.number(),
  staleWindow: StaleWindowSchema,
  taskName: z.string(),
});
export const ReplayStepSchema = z.object({
  runtimeSeq: z.number(),
  agent: z.string(),
  action: z.string(),
  description: z.string(),
  annotation: z.string(),
  highlightNodes: z.array(z.string()),
  highlightEdges: z.array(z.string()),
  openStaleWindow: z.boolean(),
  closeStaleWindow: z.boolean(),
});
export const ReplayPlanSchema = z.object({
  runId: z.string(),
  hazardId: z.string(),
  steps: z.array(ReplayStepSchema),
});
export const StreamUpdateSchema = z.object({
  runId: z.string(),
  runtimeSeq: z.number(),
  kind: z.string(),
});

export type TimelineEvent = z.infer<typeof TimelineEventSchema>;
export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;
export type HazardSummary = z.infer<typeof HazardSummarySchema>;
export type DebuggerSnapshot = z.infer<typeof DebuggerSnapshotSchema>;
export type HazardDetail = z.infer<typeof HazardDetailSchema>;
export type ReplayPlan = z.infer<typeof ReplayPlanSchema>;
export type ReplayStep = z.infer<typeof ReplayStepSchema>;
export type StreamUpdate = z.infer<typeof StreamUpdateSchema>;
export type DiffLine = z.infer<typeof DiffLineSchema>;

export interface LiveProjectionSink {
  publish(update: StreamUpdate): void;
  close(): void;
}
export class NoopLiveProjectionSink implements LiveProjectionSink {
  publish(_update: StreamUpdate): void {}
  close(): void {}
}
