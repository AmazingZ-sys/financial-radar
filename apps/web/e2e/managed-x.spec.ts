import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { AIConfigViewSchema, XConfigSchema, XConfigViewSchema } from '@radar/shared';

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

async function writeHeaders(page: Page) {
  const me = await page.request.get('/api/v1/auth/me');
  expect(me.ok()).toBe(true);
  const session = (await me.json()) as { data: { csrfToken: string } };
  return { Origin: new URL(page.url()).origin, 'X-CSRF-Token': session.data.csrfToken };
}

test('AI daily call limit saves zero and a new limit through the real API and reloads', async ({
  page,
}) => {
  await page.goto('/system');
  const response = await page.request.get('/api/v1/integrations/ai');
  expect(response.ok()).toBe(true);
  const original = AIConfigViewSchema.parse((await response.json()).data);
  const headers = await writeHeaders(page);
  const panel = page.locator('.integration-panel');
  const calls = panel.getByLabel('每日最多调用次数', { exact: true });
  await expect(calls).toBeEnabled();
  try {
    for (const limit of [0, 37]) {
      await calls.fill(String(limit));
      const save = page.waitForResponse(
        (result) =>
          result.url().endsWith('/integrations/ai') && result.request().method() === 'PATCH',
      );
      await panel.getByRole('button', { name: '保存 AI 配置', exact: true }).click();
      const saved = await save;
      expect(saved.ok()).toBe(true);
      expect(saved.request().postDataJSON()).toHaveProperty('maxDailyCalls', limit);
      expect((await saved.json()).data.maxDailyCalls).toBe(limit);
      await page.reload();
      await expect(calls).toHaveValue(String(limit));
      await expect(
        panel.getByText(limit === 0 ? '真实调用已暂停' : `已保存上限 · ${limit} 次 / UTC 日`, {
          exact: true,
        }),
      ).toBeVisible();
    }
  } finally {
    const restored = await page.request.patch('/api/v1/integrations/ai', {
      headers,
      data: { maxDailyCalls: original.maxDailyCalls },
    });
    expect(restored.ok()).toBe(true);
  }
});

test('X management persists fixture scope, hides and clears the login session, and previews honest test state', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/system');
  const response = await page.request.get('/api/v1/integrations/x');
  expect(response.ok()).toBe(true);
  const original = XConfigViewSchema.parse((await response.json()).data);
  test.skip(original.dataMode !== 'fixture', 'X UI writes require an isolated Fixture environment');
  test.skip(original.sessionConfigured, 'Preserve any existing X login session');
  const originalFields = XConfigSchema.parse(original);
  const headers = await writeHeaders(page);
  const panel = page.locator('#x-integration');
  const token = 'auth_token=synthetic_ui_auth_placeholder; ct0=synthetic_ui_csrf_placeholder';
  let aiConnectionTests = 0;
  let xConfigurationWrites = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/integrations/ai/test')) aiConnectionTests++;
    if (request.url().endsWith('/integrations/x') && request.method() === 'PATCH')
      xConfigurationWrites++;
  });
  try {
    await expect(panel.getByRole('heading', { name: 'X 讨论监测', exact: true })).toBeVisible();
    await expect(panel.getByText('Fixture · 不访问 X', { exact: true })).toBeVisible();
    await panel.getByLabel('X 登录态（auth_token 和 ct0）', { exact: true }).fill(token);
    await panel.getByLabel('关注账号', { exact: true }).fill('@sampleone\nsampletwo');
    await panel.getByLabel('关键词（可选）', { exact: true }).fill('synthetic_topic\n$SYNTH');
    await panel.getByLabel('最短采集间隔（秒）', { exact: true }).fill('600');
    await panel.getByLabel('最长采集间隔（秒）', { exact: true }).fill('900');
    await panel.getByLabel('每页最多帖子', { exact: true }).fill('20');
    await panel.getByLabel('X 每日请求上限', { exact: true }).fill('12');
    await panel.getByLabel('研究候选最少作者数', { exact: true }).fill('2');
    await panel.getByLabel('讨论聚合窗口（分钟）', { exact: true }).fill('30');
    await panel.getByLabel('启用 X 自动采集', { exact: true }).check();
    await expect(panel.getByRole('button', { name: '测试 X 连接', exact: true })).toBeDisabled();
    const save = page.waitForResponse(
      (result) => result.url().endsWith('/integrations/x') && result.request().method() === 'PATCH',
    );
    await panel.getByRole('button', { name: '保存 X 配置', exact: true }).click();
    const saved = await save;
    expect(saved.ok()).toBe(true);
    expect(saved.request().postDataJSON()).toMatchObject({
      pollIntervalMinSeconds: 600,
      pollIntervalMaxSeconds: 900,
    });
    expect(saved.request().postDataJSON()).not.toHaveProperty('pollIntervalSeconds');
    const savedBody = await saved.json();
    expect(savedBody.data).toMatchObject({
      enabled: true,
      sessionConfigured: true,
      usernames: ['sampleone', 'sampletwo'],
      keywords: ['$SYNTH', 'synthetic_topic'],
      dailyRequestLimit: 12,
      pollIntervalSeconds: 600,
      pollIntervalMinSeconds: 600,
      pollIntervalMaxSeconds: 900,
      maxResults: 20,
      candidateMinAuthors: 2,
      candidateWindowMinutes: 30,
      dataMode: 'fixture',
      source: { enabled: false },
    });
    expect(savedBody.data).not.toHaveProperty('sessionCookies');
    expect(JSON.stringify(savedBody)).not.toContain(token);
    await page.reload();
    await expect(panel.getByLabel('X 登录态（auth_token 和 ct0）', { exact: true })).toHaveValue(
      '',
    );
    await expect(panel.getByText('已加密保存', { exact: true })).toBeVisible();
    await expect(panel.getByLabel('关注账号', { exact: true })).toHaveValue('sampleone\nsampletwo');
    await expect(panel.getByLabel('关键词（可选）', { exact: true })).toHaveValue(
      '$SYNTH\nsynthetic_topic',
    );
    for (const [label, value] of [
      ['最短采集间隔（秒）', '600'],
      ['最长采集间隔（秒）', '900'],
      ['每页最多帖子', '20'],
      ['X 每日请求上限', '12'],
      ['研究候选最少作者数', '2'],
      ['讨论聚合窗口（分钟）', '30'],
    ])
      await expect(panel.getByLabel(label!, { exact: true })).toHaveValue(value!);
    await expect(panel.getByLabel('启用 X 自动采集', { exact: true })).toBeChecked();
    await expect(panel.getByTestId('x-saved-interval')).toHaveText('600–900 秒');
    const writesBeforeInvalidRange = xConfigurationWrites;
    await panel.getByLabel('最短采集间隔（秒）', { exact: true }).fill('901');
    await panel.getByRole('button', { name: '保存 X 配置', exact: true }).click();
    await expect(panel.getByRole('alert')).toHaveText('最小采集间隔不能大于最大采集间隔');
    expect(xConfigurationWrites).toBe(writesBeforeInvalidRange);
    await expect(panel.getByTestId('x-saved-interval')).toHaveText('600–900 秒');
    await page.reload();
    await expect(panel.getByLabel('最短采集间隔（秒）', { exact: true })).toHaveValue('600');
    await expect(panel.getByLabel('最长采集间隔（秒）', { exact: true })).toHaveValue('900');
    const beforeTestResponse = await page.request.get('/api/v1/integrations/x');
    const beforeTest = XConfigViewSchema.parse((await beforeTestResponse.json()).data);
    if (beforeTest.scheduling.nextRequestAt) {
      await expect(panel.getByTestId('x-next-request').locator('time')).toHaveAttribute(
        'datetime',
        beforeTest.scheduling.nextRequestAt,
      );
    } else {
      await expect(panel.getByTestId('x-next-request')).toHaveText('尚未预留真实请求');
    }
    await expect(panel.getByTestId('x-last-delay')).toHaveText(
      beforeTest.scheduling.lastDelaySeconds === null
        ? '尚未抽取'
        : `${new Intl.NumberFormat('zh-CN').format(beforeTest.scheduling.lastDelaySeconds)} 秒`,
    );
    const beforeStatus = await page.request.get('/api/v1/system/status');
    const beforeCalls = (await beforeStatus.json()).data.ai.usage.calls;
    const tested = page.waitForResponse(
      (result) =>
        result.url().endsWith('/integrations/x/test') && result.request().method() === 'POST',
    );
    await panel.getByRole('button', { name: '测试 X 连接', exact: true }).click();
    const testResponse = await tested;
    expect(testResponse.ok()).toBe(true);
    expect((await testResponse.json()).data).toMatchObject({
      status: 'skipped',
      httpStatus: null,
      returnedPosts: 0,
      samples: [],
    });
    await expect(
      panel.getByText('Fixture 模式未访问自建 X 采集器或真实 X，也未调用 AI。'),
    ).toBeVisible();
    const afterTestResponse = await page.request.get('/api/v1/integrations/x');
    const afterTest = XConfigViewSchema.parse((await afterTestResponse.json()).data);
    expect(afterTest.usage.requests).toBe(beforeTest.usage.requests);
    expect(afterTest.scheduling).toEqual(beforeTest.scheduling);
    const afterStatus = await page.request.get('/api/v1/system/status');
    expect((await afterStatus.json()).data.ai.usage.calls).toBe(beforeCalls);
    expect(aiConnectionTests).toBe(0);
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
    ).not.toContain(token);

    await mkdir(resolve('.local/managed-x'), { recursive: true });
    await panel.screenshot({ path: resolve('.local/managed-x/x-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.getByRole('heading', { name: 'X 讨论监测', exact: true }).scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await panel.screenshot({ path: resolve('.local/managed-x/x-mobile.png') });
    await panel.getByLabel('清除已保存 登录态，并关闭采集', { exact: true }).check();
    await expect(panel.getByLabel('启用 X 自动采集', { exact: true })).not.toBeChecked();
    await expect(panel.getByLabel('X 登录态（auth_token 和 ct0）', { exact: true })).toBeDisabled();
    const clearing = page.waitForResponse(
      (result) => result.url().endsWith('/integrations/x') && result.request().method() === 'PATCH',
    );
    await panel.getByRole('button', { name: '保存 X 配置', exact: true }).click();
    const cleared = await clearing;
    expect(cleared.ok()).toBe(true);
    expect((await cleared.json()).data).toMatchObject({
      enabled: false,
      sessionConfigured: false,
    });
    await page.reload();
    await expect(panel.getByLabel('X 登录态（auth_token 和 ct0）', { exact: true })).toHaveValue(
      '',
    );
    await expect(panel.getByText('未配置', { exact: true })).toBeVisible();
  } finally {
    const restored = await page.request.patch('/api/v1/integrations/x', {
      headers,
      data: { ...originalFields, enabled: false, clearSessionCookies: true },
    });
    expect(restored.ok()).toBe(true);
  }
});

test('X management explains an older backend without displaying a pretend configuration form (mock transport)', async ({
  page,
}) => {
  await page.route('**/api/v1/integrations/x', (route) =>
    route.fulfill({
      status: 404,
      json: {
        error: {
          code: 'NOT_FOUND',
          message: 'Synthetic older-backend response for UI compatibility only',
          requestId: 'synthetic-old-x-ui',
        },
      },
    }),
  );
  await page.goto('/system');
  const panel = page.locator('#x-integration');
  await expect(
    panel.getByText('当前后端尚未提供 X 接入管理，更新后可在这里配置。接入步骤可先查看。'),
  ).toBeVisible();
  await expect(panel.getByRole('heading', { name: '免费自建接入步骤', exact: true })).toBeVisible();
  await expect(panel.getByRole('link', { name: '开源采集器文档 ↗', exact: true })).toHaveAttribute(
    'href',
    'https://github.com/vladkens/twscrape',
  );
  await expect(panel.getByLabel('X 登录态（auth_token 和 ct0）', { exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '保存 X 配置', exact: true })).toHaveCount(0);
});

test('X scheduling displays the saved wait and random delay from a synthetic response (mock transport)', async ({
  page,
}) => {
  const response = await page.request.get('/api/v1/integrations/x');
  expect(response.ok()).toBe(true);
  const original = await response.json();
  const nextRequestAt = '2026-11-05T10:17:13.000Z';
  const syntheticView = XConfigViewSchema.parse({
    ...original.data,
    pollIntervalMinSeconds: 600,
    pollIntervalMaxSeconds: 1200,
    pollIntervalSeconds: 600,
    scheduling: {
      lastRequestAt: '2026-11-05T10:00:00.000Z',
      nextRequestAt,
      lastDelaySeconds: 1033,
    },
  });
  await page.route('**/api/v1/integrations/x', (route) =>
    route.fulfill({ json: { ...original, data: syntheticView } }),
  );
  await page.goto('/system');
  const panel = page.locator('#x-integration');
  await expect(panel.getByTestId('x-saved-interval')).toHaveText('600–1,200 秒');
  await expect(panel.getByTestId('x-next-request').locator('time')).toHaveAttribute(
    'datetime',
    nextRequestAt,
  );
  await expect(panel.getByTestId('x-last-delay')).toHaveText('1,033 秒');
  await expect(
    panel.getByText(
      '每次实际请求时，从已保存区间随机抽取下一次等待时间。连接测试与自动采集共用等待；保存配置不会重置已安排的等待，平台限流可能进一步延后请求。',
    ),
  ).toBeVisible();
  await panel.getByLabel('最短采集间隔（秒）', { exact: true }).fill('800');
  await expect(panel.getByTestId('x-saved-interval')).toHaveText('600–1,200 秒');
  await expect(panel.getByTestId('x-next-request').locator('time')).toHaveAttribute(
    'datetime',
    nextRequestAt,
  );
});
