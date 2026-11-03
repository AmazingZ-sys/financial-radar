import { z } from 'zod';
export * from './integrations.js';
export * from './source-config.js';
export const DataModeSchema = z.enum(['live', 'fixture']);
export type DataMode = z.infer<typeof DataModeSchema>;
export const PrioritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);
export type Priority = z.infer<typeof PrioritySchema>;
export const StageSchema = z.enum([
  'DISCOVERED',
  'UNVERIFIED',
  'VERIFIED',
  'EARLY_STAGE',
  'ACTIVE',
  'COMPLETED',
  'TRADING',
  'INACTIVE',
]);
export type ProjectStage = z.infer<typeof StageSchema>;
export const VerificationSchema = z.enum(['UNVERIFIED', 'VERIFIED', 'DISPUTED']);
export const SourceIdSchema = z.string().min(1).max(200);
const Time = z.iso.datetime({ offset: true });
export const EventSchema = z.object({
  id: z.uuid(),
  eventType: z.string(),
  sourceId: z.string(),
  externalId: z.string(),
  title: z.string(),
  description: z.string(),
  originalUrl: z.url().nullable(),
  sourcePublishedAt: Time.nullable(),
  firstSeenAt: Time,
  collectedAt: Time,
  eventOccurredAt: Time.nullable(),
  normalizedAt: Time.optional(),
  detectedAt: Time.optional(),
  assets: z.array(z.string()),
  categories: z.array(z.string()),
  chain: z.string().optional(),
  assetKey: z.string().optional(),
  metrics: z.record(z.string(), z.union([z.number().finite(), z.string(), z.null()])).optional(),
  conditionsVerified: z.boolean().optional(),
  rawDataReference: z.string(),
  fingerprint: z.string(),
  confidence: z.number().min(0).max(1),
  severity: PrioritySchema,
  verificationStatus: VerificationSchema,
  analysisStatus: z.enum(['PENDING', 'COMPLETED', 'FAILED', 'DISABLED', 'DEFERRED']),
  opportunityScore: z.number().min(0).max(100),
  riskScore: z.number().min(0).max(100),
  dataMode: DataModeSchema,
  createdAt: Time,
  updatedAt: Time,
  review: z
    .object({
      status: z.enum(['APPROVED', 'REJECTED']),
      note: z.string(),
      reviewerId: z.uuid(),
      reviewedAt: Time,
    })
    .optional(),
  analysis: z.unknown().optional(),
  evidence: z.array(z.unknown()).optional(),
  riskWarnings: z.array(z.string()).default([]),
  opportunityBreakdown: z.unknown().optional(),
  riskBreakdown: z.unknown().optional(),
});
export type RadarEvent = z.infer<typeof EventSchema>;
export type Event = RadarEvent;
export const ProjectSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  chain: z.string(),
  protocol: z.string(),
  assetKey: z.string(),
  stage: StageSchema,
  verificationStatus: VerificationSchema,
  riskFlagged: z.boolean(),
  watching: z.boolean(),
  firstSeenAt: Time,
  opportunityScore: z.number().min(0).max(100),
  riskScore: z.number().min(0).max(100),
  participants: z.number().nonnegative().nullable(),
  participantGrowthPct: z.number().nullable(),
  mintProgress: z.number().min(0).max(100).nullable(),
  conditions: z.string().nullable(),
  conditionsVerified: z.boolean().default(false),
  sourceUrls: z.array(z.url()),
  dataMode: DataModeSchema,
  startsAt: Time.nullable().optional(),
  endsAt: Time.nullable().optional(),
  opportunityBreakdown: z.unknown().optional(),
  riskBreakdown: z.unknown().optional(),
  riskWarnings: z.array(z.string()).default([]),
  updatedAt: Time.optional(),
});
export type Project = z.infer<typeof ProjectSchema>;
export const RuleConditionsSchema = z
  .object({
    eventTypes: z.array(z.string().max(100)).max(30).optional(),
    sourceIds: z.array(SourceIdSchema).max(30).optional(),
    assets: z.array(z.string().max(100)).max(50).optional(),
    categories: z.array(z.string().max(100)).max(30).optional(),
    chains: z.array(z.string().max(100)).max(30).optional(),
    stages: z.array(StageSchema).max(8).optional(),
    minConfidence: z.number().min(0).max(1).optional(),
    minOpportunityScore: z.number().min(0).max(100).optional(),
    maxRiskScore: z.number().min(0).max(100).optional(),
    minParticipantGrowthPct: z.number().min(0).max(1e6).optional(),
    minMintProgress: z.number().min(0).max(100).optional(),
    maxMintProgress: z.number().min(0).max(100).optional(),
    minPriceChangePct: z.number().min(0).max(1e6).optional(),
    minYieldChangeBps: z.number().min(0).max(1e6).optional(),
    windowSeconds: z.number().int().min(60).max(604800).optional(),
    maxAgeSeconds: z.number().int().min(0).max(31536000).optional(),
    verifiedOnly: z.boolean().optional(),
  })
  .strict();
export type RuleConditions = z.infer<typeof RuleConditionsSchema>;
export const RuleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean().default(true),
    conditions: RuleConditionsSchema,
    priority: PrioritySchema.default('P2'),
    cooldownSeconds: z.number().int().min(60).max(604800).default(3600),
    channelIds: z.array(z.uuid()).max(10).default([]),
  })
  .strict();
export const RuleSchema = RuleInputSchema.extend({
  id: z.uuid(),
  ownerId: z.uuid(),
  version: z.number().int(),
  createdAt: Time,
  updatedAt: Time,
});
export type AlertRule = z.infer<typeof RuleSchema>;
export type RuleInput = z.infer<typeof RuleInputSchema>;
export const SourceSchema = z.object({
  id: SourceIdSchema,
  name: z.string(),
  connectorType: z.string(),
  mode: DataModeSchema,
  enabled: z.boolean(),
  status: z.string(),
  intervalSeconds: z.number(),
  lastSuccessAt: Time.nullable(),
  lastError: z.string().nullable(),
  nextPollAt: Time.nullable(),
  successRate: z.number().nullable(),
  latencyMs: z.number().nullable(),
  freshnessSeconds: z.number().nullable(),
  description: z.string().default(''),
  docsUrl: z.string().nullable().default(null),
  keyConfigured: z.boolean().default(false),
  capabilities: z.array(z.string()).default([]),
  delayLabel: z.string().default('由来源决定'),
  categories: z.array(z.string()).default([]),
  custom: z.boolean().default(false),
  feedUrl: z.string().nullable().default(null),
});
export type DataSource = z.infer<typeof SourceSchema>;
export const NotificationSchema = z.object({
  id: z.uuid(),
  channelId: z.uuid(),
  eventId: z.uuid().nullable(),
  status: z.enum(['PENDING', 'SENDING', 'SENT', 'FAILED', 'RETRYING', 'CANCELLED']),
  attempts: z.number().int(),
  queuedAt: Time,
  acceptedAt: Time.nullable(),
  lastError: z.string().nullable(),
  title: z.string(),
  body: z.string().default(''),
  priority: PrioritySchema.default('P2'),
  dataMode: DataModeSchema,
});
export type Notification = z.infer<typeof NotificationSchema>;
export const ChannelSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  provider: z.enum(['telegram', 'feishu', 'bark']),
  enabled: z.boolean(),
  configured: z.boolean(),
  description: z.string().default(''),
});
export type NotificationChannel = z.infer<typeof ChannelSchema>;
export const MarketSchema = z.object({
  asset: z.string(),
  name: z.string(),
  value: z.number().nullable(),
  unit: z.string(),
  changePct: z.number().nullable(),
  sourceId: z.string(),
  observedAt: Time.nullable(),
  delaySeconds: z.number().nullable(),
  dataMode: DataModeSchema,
  frequency: z.string().optional(),
  sourceDate: z.string().nullable().optional(),
  precision: z.number().nullable().optional(),
  publicationTimeKnown: z.boolean().optional(),
  delayLabel: z.string().optional(),
  sourceUrl: z.string().optional(),
  rawDataReference: z.string().optional(),
});
export type MarketAsset = z.infer<typeof MarketSchema>;
export const SettingsSchema = z.object({
  theme: z.enum(['dark', 'light', 'system']).default('dark'),
  timezone: z
    .string()
    .refine((v) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, '无效时区')
    .default('Asia/Shanghai'),
  locale: z.string().max(20).default('zh-CN'),
  notifications: z
    .object({
      quietStart: z.number().int().min(0).max(23).nullable().default(null),
      quietEnd: z.number().int().min(0).max(23).nullable().default(null),
      minimumPriority: PrioritySchema.default('P2'),
    })
    .default({ quietStart: null, quietEnd: null, minimumPriority: 'P2' }),
});
export type UserSettings = z.infer<typeof SettingsSchema>;
export const SignalSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid().nullable(),
  eventId: z.uuid().nullable(),
  type: z.string(),
  detectedAt: Time,
  opportunityScore: z.number(),
  riskScore: z.number(),
  evidenceIds: z.array(z.string()),
  reason: z.string(),
  scoringVersion: z.string(),
});
export type OpportunitySignal = z.infer<typeof SignalSchema>;
export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export const ErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), requestId: z.string() }),
});
export const MetaSchema = z.object({
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  dataMode: DataModeSchema,
  asOf: Time,
});
export const envelope = <T extends z.ZodType>(schema: T) =>
  z.object({ data: schema, meta: MetaSchema.optional() });
export const DashboardSchema = z.object({
  onlineSources: z.number(),
  totalSources: z.number(),
  collectedToday: z.number(),
  eventsToday: z.number(),
  projectsToday: z.number(),
  highPriorityAlerts: z.number(),
  notificationSuccessRate: z.number().nullable(),
  recentEvents: z.array(EventSchema),
  recentProjects: z.array(ProjectSchema),
  recentAlerts: z.array(z.unknown()),
  workerOnline: z.boolean(),
  dataMode: DataModeSchema,
  asOf: Time,
  latency: z.object({
    p50Ms: z.number().nullable(),
    p95Ms: z.number().nullable(),
    samples: z.number(),
  }),
  trend: z.array(z.object({ time: z.string(), events: z.number(), signals: z.number() })),
});
export type Dashboard = z.infer<typeof DashboardSchema>;
