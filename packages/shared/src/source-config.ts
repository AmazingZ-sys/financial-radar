import { z } from 'zod';

export const MarketSourceMinimumIntervals: Readonly<Record<string, number>> = {
  'gold-api-xau': 60,
  'eia-wti-daily': 3600,
};

export const SourceCategorySchema = z.enum(['macro', 'finance', 'technology', 'world', 'crypto']);
export const SourceCategoryLabels: Record<z.infer<typeof SourceCategorySchema>, string> = {
  macro: '宏观政策',
  finance: '财经市场',
  technology: '科技动态',
  world: '全球热点',
  crypto: '加密资产',
};
export const FeedUrlSchema = z
  .url()
  .max(2000)
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  }, '订阅地址须为不含凭据、查询参数和片段的公开 HTTPS URL');
export const SourceInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    feedUrl: FeedUrlSchema,
    categories: z
      .array(SourceCategorySchema)
      .min(1)
      .max(5)
      .transform((values) => [...new Set(values)]),
    intervalSeconds: z.number().int().min(60).max(86400).default(300),
    enabled: z.boolean().default(true),
  })
  .strict();
export const SourceCatalogSchema = z.object({
  id: z.string(),
  name: z.string(),
  categories: z.array(z.string()),
  description: z.string(),
  docsUrl: z.url(),
  feedUrl: z.url().nullable(),
  intervalSeconds: z.number(),
  licenseStatus: z.string(),
  requiresConfiguration: z.boolean(),
  installed: z.boolean(),
  enabled: z.boolean(),
});
export type SourceInput = z.infer<typeof SourceInputSchema>;
export type SourceCatalog = z.infer<typeof SourceCatalogSchema>;
