import {
  pgTable,
  text,
  uuid,
  boolean,
  timestamp,
  integer,
  jsonb,
  numeric,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import type { RadarEvent, Project, AlertRule, OpportunitySignal } from '@radar/shared';
const time = (name: string) => timestamp(name, { withTimezone: true });
export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('admin'),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: time('created_at').notNull().defaultNow(),
});
export const sessions = pgTable('user_sessions', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  csrfToken: text('csrf_token').notNull(),
  expiresAt: time('expires_at').notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
});
export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  data: jsonb('data').notNull(),
  updatedAt: time('updated_at').notNull().defaultNow(),
});
export const watchlists = pgTable('watchlists', {
  id: uuid('id').primaryKey(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  name: text('name').notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
});
export const watchlistItems = pgTable(
  'watchlist_items',
  {
    id: uuid('id').primaryKey(),
    watchlistId: uuid('watchlist_id')
      .notNull()
      .references(() => watchlists.id),
    assetKey: text('asset_key').notNull(),
    createdAt: time('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('watchlist_items_unique').on(t.watchlistId, t.assetKey)],
);
export const dataSources = pgTable('data_sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  connectorType: text('connector_type').notNull().default('pull'),
  mode: text('mode').notNull(),
  intervalSeconds: integer('interval_seconds').notNull().default(60),
  lastSuccessAt: time('last_success_at'),
  lastError: text('last_error'),
  nextPollAt: time('next_poll_at'),
  data: jsonb('data').notNull().default({}),
  updatedAt: time('updated_at').notNull().defaultNow(),
});
export const sourceCheckpoints = pgTable('source_checkpoints', {
  sourceId: text('source_id')
    .primaryKey()
    .references(() => dataSources.id),
  cursor: jsonb('cursor').notNull(),
  committedAt: time('committed_at').notNull().defaultNow(),
});
export const sourcePendingBatches = pgTable('source_pending_batches', {
  sourceId: text('source_id')
    .primaryKey()
    .references(() => dataSources.id, { onDelete: 'cascade' }),
  integrationScope: text('integration_scope'),
  data: jsonb('data').notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
});
export const sourceHealthRecords = pgTable('source_health_records', {
  id: uuid('id').primaryKey(),
  sourceId: text('source_id')
    .notNull()
    .references(() => dataSources.id),
  status: text('status').notNull(),
  latencyMs: integer('latency_ms'),
  error: text('error'),
  observedAt: time('observed_at').notNull().defaultNow(),
});
export const ingestionRuns = pgTable('ingestion_runs', {
  id: uuid('id').primaryKey(),
  sourceId: text('source_id')
    .notNull()
    .references(() => dataSources.id),
  status: text('status').notNull(),
  fetched: integer('fetched').notNull().default(0),
  inserted: integer('inserted').notNull().default(0),
  error: text('error'),
  startedAt: time('started_at').notNull().defaultNow(),
  finishedAt: time('finished_at'),
});
export const rawItems = pgTable(
  'raw_items',
  {
    id: uuid('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => dataSources.id),
    externalId: text('external_id').notNull(),
    payload: jsonb('payload').notNull(),
    publishedAt: time('published_at'),
    firstSeenAt: time('first_seen_at').notNull(),
    collectedAt: time('collected_at').notNull(),
  },
  (t) => [uniqueIndex('raw_source_external').on(t.sourceId, t.externalId)],
);
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey(),
    fingerprint: text('fingerprint').notNull().unique(),
    sourceId: text('source_id')
      .notNull()
      .references(() => dataSources.id),
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    eventType: text('event_type').notNull(),
    severity: text('severity').notNull(),
    firstSeenAt: time('first_seen_at').notNull(),
    data: jsonb('data').$type<RadarEvent>().notNull(),
    createdAt: time('created_at').notNull().defaultNow(),
    updatedAt: time('updated_at').notNull().defaultNow(),
  },
  (t) => [index('events_seen').on(t.firstSeenAt)],
);
export const eventSources = pgTable('event_sources', {
  id: uuid('id').primaryKey(),
  eventId: uuid('event_id')
    .notNull()
    .references(() => events.id),
  sourceId: text('source_id')
    .notNull()
    .references(() => dataSources.id),
  rawItemId: uuid('raw_item_id')
    .notNull()
    .references(() => rawItems.id),
  url: text('url'),
  sourcePublishedAt: time('source_published_at'),
  data: jsonb('data').notNull().default({}),
});
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey(),
  assetKey: text('asset_key').notNull().unique(),
  stage: text('stage').notNull(),
  chain: text('chain').notNull(),
  firstSeenAt: time('first_seen_at').notNull(),
  data: jsonb('data').$type<Project>().notNull(),
  updatedAt: time('updated_at').notNull().defaultNow(),
});
export const projectLifecycleEvents = pgTable('project_lifecycle_events', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  fromStage: text('from_stage'),
  toStage: text('to_stage').notNull(),
  reason: text('reason').notNull(),
  evidenceIds: jsonb('evidence_ids').notNull(),
  occurredAt: time('occurred_at').notNull(),
  recordedAt: time('recorded_at').notNull().defaultNow(),
});
export const projectMetrics = pgTable('project_metrics', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  sourceId: text('source_id')
    .notNull()
    .references(() => dataSources.id),
  observedAt: time('observed_at').notNull(),
  data: jsonb('data').notNull(),
});
export const opportunitySignals = pgTable('opportunity_signals', {
  id: uuid('id').primaryKey(),
  dedupKey: text('dedup_key').notNull().unique(),
  projectId: uuid('project_id').references(() => projects.id),
  eventId: uuid('event_id').references(() => events.id),
  detectedAt: time('detected_at').notNull(),
  data: jsonb('data').$type<OpportunitySignal>().notNull(),
});
export const riskAssessments = pgTable('risk_assessments', {
  id: uuid('id').primaryKey(),
  projectId: uuid('project_id').references(() => projects.id),
  eventId: uuid('event_id').references(() => events.id),
  score: integer('score').notNull(),
  version: text('version').notNull(),
  data: jsonb('data').notNull(),
  assessedAt: time('assessed_at').notNull().defaultNow(),
});
export const alertRules = pgTable('alert_rules', {
  id: uuid('id').primaryKey(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  version: integer('version').notNull().default(1),
  data: jsonb('data').$type<AlertRule>().notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
  updatedAt: time('updated_at').notNull().defaultNow(),
});
export const alertRuleVersions = pgTable('alert_rule_versions', {
  id: uuid('id').primaryKey(),
  ruleId: uuid('rule_id')
    .notNull()
    .references(() => alertRules.id),
  version: integer('version').notNull(),
  data: jsonb('data').notNull(),
  createdAt: time('created_at').notNull().defaultNow(),
});
export const alertTriggers = pgTable('alert_triggers', {
  id: uuid('id').primaryKey(),
  ruleId: uuid('rule_id')
    .notNull()
    .references(() => alertRules.id),
  ruleVersion: integer('rule_version').notNull(),
  eventId: uuid('event_id').references(() => events.id),
  signalId: uuid('signal_id').references(() => opportunitySignals.id),
  dedupKey: text('dedup_key').notNull().unique(),
  data: jsonb('data').notNull(),
  detectedAt: time('detected_at').notNull().defaultNow(),
});
export const notificationChannels = pgTable('notification_channels', {
  id: uuid('id').primaryKey(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  provider: text('provider').notNull(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  data: jsonb('data').notNull().default({}),
  createdAt: time('created_at').notNull().defaultNow(),
});
export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey(),
  dedupKey: text('dedup_key').notNull().unique(),
  channelId: uuid('channel_id')
    .notNull()
    .references(() => notificationChannels.id),
  eventId: uuid('event_id').references(() => events.id),
  status: text('status').notNull().default('PENDING'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: time('next_attempt_at').notNull().defaultNow(),
  queuedAt: time('queued_at').notNull().defaultNow(),
  acceptedAt: time('accepted_at'),
  lockedUntil: time('locked_until'),
  lastError: text('last_error'),
  data: jsonb('data').notNull(),
});
export const notificationAttempts = pgTable('notification_attempts', {
  id: uuid('id').primaryKey(),
  notificationId: uuid('notification_id')
    .notNull()
    .references(() => notifications.id),
  attemptNo: integer('attempt_no').notNull(),
  startedAt: time('started_at').notNull().defaultNow(),
  finishedAt: time('finished_at'),
  outcome: text('outcome').notNull(),
  platformMessageId: text('platform_message_id'),
  error: text('error'),
  data: jsonb('data').notNull().default({}),
});
export const aiAnalysisRuns = pgTable('ai_analysis_runs', {
  id: uuid('id').primaryKey(),
  eventId: uuid('event_id').references(() => events.id),
  status: text('status').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  promptVersion: text('prompt_version').notNull(),
  cacheKey: text('cache_key').notNull().unique(),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  estimatedCost: numeric('estimated_cost', { precision: 14, scale: 8 }),
  data: jsonb('data').notNull().default({}),
  error: text('error'),
  createdAt: time('created_at').notNull().defaultNow(),
  completedAt: time('completed_at'),
});
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey(),
  actorId: uuid('actor_id').references(() => users.id),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  requestId: text('request_id'),
  details: jsonb('details').notNull().default({}),
  createdAt: time('created_at').notNull().defaultNow(),
});
export const systemSettings = pgTable('system_settings', {
  key: text('key').primaryKey(),
  data: jsonb('data').notNull(),
  updatedAt: time('updated_at').notNull().defaultNow(),
});
export const marketObservations = pgTable('market_observations', {
  id: uuid('id').primaryKey(),
  assetKey: text('asset_key').notNull(),
  sourceId: text('source_id')
    .notNull()
    .references(() => dataSources.id),
  observedAt: time('observed_at').notNull(),
  value: numeric('value', { precision: 30, scale: 10 }).notNull(),
  unit: text('unit').notNull(),
  delaySeconds: integer('delay_seconds'),
  data: jsonb('data').notNull().default({}),
});
export const outboxJobs = pgTable('outbox_jobs', {
  id: uuid('id').primaryKey(),
  dedupKey: text('dedup_key').notNull().unique(),
  kind: text('kind').notNull(),
  entityId: uuid('entity_id').notNull(),
  status: text('status').notNull().default('PENDING'),
  availableAt: time('available_at').notNull().defaultNow(),
  lockedUntil: time('locked_until'),
  attempts: integer('attempts').notNull().default(0),
  createdAt: time('created_at').notNull().defaultNow(),
});

export const economicCalendar = pgTable(
  'economic_calendar',
  {
    id: uuid('id').primaryKey(),
    sourceId: text('source_id').notNull(),
    externalId: text('external_id').notNull(),
    country: text('country').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    dataMode: text('data_mode').notNull(),
    data: jsonb('data').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('calendar_source_external_mode').on(t.sourceId, t.externalId, t.dataMode),
    index('calendar_time').on(t.dataMode, t.scheduledAt),
  ],
);
