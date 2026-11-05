import { expect, test, type BrowserContext } from '@playwright/test';
import { EventSchema, RuleSchema } from '@radar/shared';

let authenticatedState: Awaited<ReturnType<BrowserContext['storageState']>>;
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('/');
  await page
    .getByLabel('管理员邮箱')
    .fill(process.env.E2E_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@radar.local');
  await page
    .getByLabel('登录密码')
    .fill(process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? 'change-me-local-only');
  await page.getByRole('button', { name: '登录工作台' }).click();
  await expect(page.getByRole('heading', { name: '雷达总览.' })).toBeVisible();
  authenticatedState = await page.context().storageState();
  await page.close();
});
test.beforeEach(async ({ context }) => {
  await context.addCookies(authenticatedState.cookies);
});

test('skipped analysis explains expiry and retains evidence (mock event transport)', async ({
  page,
}) => {
  // Synthetic responses test rendering only; no real event or AI call is created.
  const id = '50000000-0000-4000-8000-000000000001';
  const at = new Date(Date.now() - 2 * 3600_000).toISOString();
  const event = EventSchema.parse({
    id,
    eventType: 'OFFICIAL_ANNOUNCEMENT',
    sourceId: 'synthetic-ui-source',
    externalId: 'synthetic-skipped-event',
    title: '合成 UI 测试 · 已过期候选',
    description: '合成事件，仅验证跳过说明与证据展示。',
    originalUrl: 'https://example.com/synthetic-evidence',
    sourcePublishedAt: at,
    firstSeenAt: at,
    collectedAt: at,
    eventOccurredAt: null,
    rawDataReference: 'synthetic-ui-evidence',
    fingerprint: 'synthetic-ui-only',
    assets: [],
    categories: ['crypto'],
    confidence: 0.9,
    severity: 'P3',
    verificationStatus: 'UNVERIFIED',
    analysisStatus: 'SKIPPED',
    analysisDecision: {
      version: 'candidate-first-v1',
      reason: 'STALE_FIRST_SEEN_AT',
      decidedAt: new Date().toISOString(),
    },
    opportunityScore: 0,
    riskScore: 50,
    dataMode: 'fixture',
    createdAt: at,
    updatedAt: at,
  });
  await page.route(`**/api/v1/events/${id}`, (route) => route.fulfill({ json: { data: event } }));
  await page.route(`**/api/v1/events/${id}/sources`, (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: 'synthetic-ui-evidence',
            title: '合成 UI 原始证据',
            sourceId: event.sourceId,
            rawItemId: event.rawDataReference,
            firstSeenAt: at,
            collectedAt: at,
            sourcePublishedAt: null,
            payload: { transport: 'UI mock evidence', dataMode: 'fixture' },
          },
        ],
        meta: { total: 1, page: 1, pageSize: 20, dataMode: 'fixture', asOf: at },
      },
    }),
  );
  await page.goto(`/events/${id}`);
  await expect(page.getByRole('heading', { name: event.title })).toBeVisible();
  const analysis = page.locator('.detail-panel').filter({
    has: page.getByRole('heading', { name: 'AI 辅助解读', exact: true }),
  });
  await expect(analysis.getByText('已跳过', { exact: true })).toBeVisible();
  await expect(analysis).toContainText('信息已超过一小时的分析窗口，已跳过付费分析。');
  await expect(analysis).toContainText('规则与确定性预警独立运行。');
  await expect(page.getByText('合成 UI 原始证据', { exact: true })).toBeVisible();
  await page.getByText('展开原始 payload', { exact: true }).click();
  await expect(page.locator('.evidence-json')).toContainText('UI mock evidence');
});

test('market snapshot selection saves and clears without enabling raw chain notifications', async ({
  page,
}) => {
  await page.goto('/rules');
  const existing = await page.request.get('/api/v1/alert-rules');
  expect(existing.ok()).toBe(true);
  const list = (await existing.json()) as { meta: { dataMode: string } };
  test.skip(list.meta.dataMode !== 'fixture', 'Creates an isolated rule only in fixture mode');
  const me = await page.request.get('/api/v1/auth/me');
  expect(me.ok()).toBe(true);
  const session = (await me.json()) as { data: { csrfToken: string } };
  const headers = {
    Origin: new URL(page.url()).origin,
    'X-CSRF-Token': session.data.csrfToken,
  };
  const name = `E2E行情快照-${Date.now()}`;
  const created = await page.request.post('/api/v1/alert-rules', {
    headers,
    data: {
      name,
      enabled: false,
      priority: 'P2',
      conditions: { minConfidence: 0.8 },
      cooldownSeconds: 3600,
      channelIds: [],
    },
  });
  expect(created.ok()).toBe(true);
  const rule = RuleSchema.parse((await created.json()).data);
  const card = page.locator('.rule-card').filter({ hasText: name });
  const optIn = page.getByLabel('包含行情快照', { exact: true });
  try {
    await page.reload();
    await card.getByRole('button', { name: `编辑${name}` }).click();
    await expect(optIn).not.toBeChecked();
    await expect(
      page.getByText('和链上状态快照只记录观察，勾选也不会发送。', { exact: false }),
    ).toBeVisible();
    await optIn.check();
    const saveEnabled = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/alert-rules/${rule.id}`) &&
        response.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: '保存规则', exact: true }).click();
    const enabled = await saveEnabled;
    expect(enabled.ok()).toBe(true);
    expect(enabled.request().postDataJSON().conditions.includeRoutineEvents).toBe(true);
    expect((await enabled.json()).data.conditions.includeRoutineEvents).toBe(true);
    await expect(card).toContainText('包含行情快照');
    await page.reload();
    await card.getByRole('button', { name: `编辑${name}` }).click();
    await expect(optIn).toBeChecked();
    await optIn.uncheck();
    const saveDefault = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/alert-rules/${rule.id}`) &&
        response.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: '保存规则', exact: true }).click();
    const cleared = await saveDefault;
    expect(cleared.ok()).toBe(true);
    expect(cleared.request().postDataJSON().conditions).not.toHaveProperty('includeRoutineEvents');
    expect((await cleared.json()).data.conditions).not.toHaveProperty('includeRoutineEvents');
    await expect(card).not.toContainText('包含行情快照');
    await page.reload();
    await card.getByRole('button', { name: `编辑${name}` }).click();
    await expect(optIn).not.toBeChecked();
  } finally {
    const removed = await page.request.delete(`/api/v1/alert-rules/${rule.id}`, { headers });
    expect(removed.ok()).toBe(true);
  }
});
