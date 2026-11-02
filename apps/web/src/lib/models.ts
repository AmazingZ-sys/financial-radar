export type {
  RadarEvent,
  Project,
  DataSource as Source,
  AlertRule as Rule,
  NotificationChannel as Channel,
  Notification,
  MarketAsset,
  OpportunitySignal as Signal,
} from '@radar/shared';
export interface Evidence {
  id?: string;
  sourceId?: string;
  rawItemId?: string;
  url?: string;
  originalUrl?: string;
  title?: string;
  description?: string;
  publishedAt?: string | null;
  sourcePublishedAt?: string | null;
  firstSeenAt?: string | null;
  collectedAt?: string;
  dataMode?: string;
  payload?: unknown;
}
export interface MarketPoint {
  frequency?: string;
  sourceDate?: string | null;
  value: number;
  observedAt?: string;
  timestamp?: string;
  asOf?: string;
  sourceId?: string;
  dataMode?: string;
}
export interface TimelineItem {
  id?: string;
  type?: string;
  eventType?: string;
  title?: string;
  description?: string;
  createdAt?: string;
  occurredAt?: string;
  recordedAt?: string;
  fromStage?: string | null;
  toStage?: string;
  reason?: string;
  timestamp?: string;
  stage?: string;
  details?: Record<string, unknown>;
}
export interface Watchlist {
  id: string;
  name: string;
  items?: { id?: string; assetKey?: string; asset?: string; label?: string }[];
}
