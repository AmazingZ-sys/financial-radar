import { expect, test } from '@playwright/test';
import { SourceCatalogSchema, SourceSchema } from '@radar/shared';

test('X source controls route to system management while other sources retain toggles (mock transport)', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByLabel('管理员邮箱')
    .fill(process.env.E2E_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@radar.local');
  await page
    .getByLabel('登录密码')
    .fill(process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? 'change-me-local-only');
  await page.getByRole('button', { name: '登录工作台' }).click();
  await expect(page.getByRole('heading', { name: '雷达总览.' })).toBeVisible();

  const syntheticX = SourceSchema.parse({
    id: 'x-search',
    name: 'Synthetic X source controls',
    connectorType: 'pull',
    mode: 'live',
    enabled: true,
    status: 'pending',
    intervalSeconds: 600,
    lastSuccessAt: null,
    lastError: null,
    nextPollAt: null,
    successRate: null,
    latencyMs: null,
    freshnessSeconds: null,
    description: 'Synthetic UI transport only; no real X collection.',
    delayLabel: '600–1200s随机间隔；来源延迟未知',
    categories: ['crypto'],
  });
  const syntheticOther = SourceSchema.parse({
    ...syntheticX,
    id: 'synthetic-other-source',
    name: 'Synthetic other source controls',
    delayLabel: '600s轮询；来源延迟未知',
  });
  const catalog = [syntheticX, syntheticOther].map((source) =>
    SourceCatalogSchema.parse({
      ...source,
      docsUrl: 'https://example.com/synthetic-source-docs',
      feedUrl: null,
      licenseStatus: 'Synthetic UI evidence only',
      requiresConfiguration: true,
      installed: true,
    }),
  );
  const meta = {
    total: 2,
    page: 1,
    pageSize: 20,
    dataMode: 'live',
    asOf: '2026-11-05T00:00:00.000Z',
  };
  await page.route('**/api/v1/sources', (route) =>
    route.fulfill({ json: { data: [syntheticX, syntheticOther], meta } }),
  );
  await page.route('**/api/v1/sources/catalog', (route) =>
    route.fulfill({ json: { data: catalog, meta } }),
  );
  let sourceWrites = 0;
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && new URL(request.url()).pathname.includes('/sources/'))
      sourceWrites++;
  });
  await page.goto('/sources');
  const xCard = page.locator('.source-card').filter({ hasText: syntheticX.name });
  const otherCard = page.locator('.source-card').filter({ hasText: syntheticOther.name });
  await expect(xCard).toBeVisible();
  await expect(xCard.getByRole('switch')).toHaveCount(0);
  const cardManagement = xCard.getByRole('link', { name: '管理 X 采集 →', exact: true });
  await expect(cardManagement).toHaveAttribute('href', '/system#x-integration');
  await expect(xCard).toContainText(syntheticX.delayLabel);
  await expect(otherCard.getByRole('switch')).toBeVisible();

  const xCatalog = page.locator('.source-catalog-row').filter({ hasText: syntheticX.name });
  const otherCatalog = page.locator('.source-catalog-row').filter({ hasText: syntheticOther.name });
  await expect(xCatalog.getByRole('button', { name: /启用来源|停用来源/ })).toHaveCount(0);
  await expect(xCatalog.getByRole('link', { name: '管理 X 采集 →', exact: true })).toHaveAttribute(
    'href',
    '/system#x-integration',
  );
  await expect(otherCatalog.getByRole('button', { name: '停用来源', exact: true })).toBeVisible();
  await cardManagement.click();
  await expect(page).toHaveURL(/\/system#x-integration$/);
  await expect(
    page.locator('#x-integration').getByRole('heading', { name: 'X 讨论监测', exact: true }),
  ).toBeVisible();
  expect(sourceWrites).toBe(0);
});
