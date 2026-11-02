export type DataMode = 'live' | 'fixture';
export type SourceMetadata = {
  id: string;
  name: string;
  officialUrl: string;
  transport: 'pull' | 'streaming' | 'webhook';
  mode: DataMode;
  categories: string[];
  trust: number;
  pollIntervalSeconds: number;
  licenseStatus: 'official-public' | 'internal-research-only' | 'authorization-required';
};
export type CapabilityDescriptor = {
  history: boolean;
  checkpoint: boolean;
  scope: 'watchlist' | 'partial' | 'full';
  sourceTimestamp: boolean;
};
export type RateLimitPolicy = { maxRequests: number; windowMs: number; respectRetryAfter: boolean };
export type Cursor = Record<string, unknown>;
export type RawItem = {
  externalId: string;
  payload: Record<string, unknown>;
  publishedAt: string | null;
};
export type ProjectInput = {
  assetKey: string;
  name: string;
  chain: string;
  protocol: string;
  stage: string;
  conditions: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
};
export type NormalizedEvent = {
  sourceId: string;
  externalId: string;
  title: string;
  description: string;
  eventType: string;
  originalUrl: string;
  sourcePublishedAt: string | null;
  eventOccurredAt: string | null;
  assets: string[];
  categories: string[];
  chain?: string;
  assetKey?: string;
  identity?: string;
  confidence: number;
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  verificationStatus: 'VERIFIED' | 'UNVERIFIED';
  dataMode: DataMode;
  project?: ProjectInput;
  signalType?: string;
  metrics?: Record<string, number | string | null>;
  riskFlags?: string[];
  conditionsVerified?: boolean;
};
export type FetchResult = { items: RawItem[]; cursor: Cursor };
export interface Connector {
  metadata: SourceMetadata;
  capabilities: CapabilityDescriptor;
  rateLimit: RateLimitPolicy;
  initialize(): Promise<void>;
  fetch(cursor?: Cursor): Promise<FetchResult>;
  normalize(item: RawItem): NormalizedEvent;
  healthCheck(): Promise<{ status: 'healthy' | 'unconfigured' | 'degraded'; detail: string }>;
  shutdown(): Promise<void>;
}
export interface StreamingConnector extends Omit<Connector, 'fetch'> {
  subscribe(onItem: (item: RawItem) => Promise<void>): Promise<void>;
}
export interface WebhookConnector extends Omit<Connector, 'fetch'> {
  verify(body: string, signature: string, timestamp: string): boolean;
  receive(body: string): RawItem[];
}
