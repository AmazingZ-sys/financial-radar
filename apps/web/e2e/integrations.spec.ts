import { expect, test, type BrowserContext } from '@playwright/test';

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

test('AI relay configuration saves through the API and reloads without returning keys', async ({
  page,
}) => {
  await page.goto('/system');
  const panel = page.locator('.integration-panel');
  await expect(panel.getByRole('heading', { name: 'AI Provider 配置' })).toBeVisible();
  await expect(page.getByLabel('Provider 名称')).not.toHaveValue('');
  const original = {
    name: await page.getByLabel('Provider 名称').inputValue(),
    enabled: await page.getByLabel('AI 分析', { exact: true }).inputValue(),
    baseUrl: await page.getByLabel('API Base URL').inputValue(),
    model: await page.getByLabel('模型名称').inputValue(),
  };
  const name = `UI relay ${Date.now()}`;
  try {
    await page.getByLabel('Provider 名称').fill(name);
    await page.getByLabel('AI 分析', { exact: true }).selectOption('false');
    await page.getByLabel('API Base URL').fill('https://example.com/relay/v1');
    await page.getByLabel('模型名称').fill('ui-model');
    await expect(panel.getByRole('button', { name: '测试 AI 连接' })).toBeDisabled();
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith('/integrations/ai') && response.request().method() === 'PATCH',
    );
    await panel.getByRole('button', { name: '保存 AI 配置' }).click();
    const response = await responsePromise;
    expect(response.ok()).toBe(true);
    expect(JSON.stringify(await response.json())).not.toContain('"apiKey":');
    await expect(
      page.getByText('AI 配置已保存，后续分析使用新配置', { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Provider 名称')).toHaveValue(name);
    await expect(page.getByLabel('API Base URL')).toHaveValue('https://example.com/relay/v1');
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  } finally {
    await page.getByLabel('Provider 名称').fill(original.name);
    await page.getByLabel('AI 分析', { exact: true }).selectOption(original.enabled);
    await page.getByLabel('API Base URL').fill(original.baseUrl);
    await page.getByLabel('模型名称').fill(original.model);
    await panel.getByRole('button', { name: '保存 AI 配置' }).click();
    await expect(
      page.getByText('AI 配置已保存，后续分析使用新配置', { exact: true }),
    ).toBeVisible();
  }
});

test('notification credential drafts clear when the configuration dialog closes', async ({
  page,
}) => {
  await page.goto('/notifications');
  const telegram = page.locator('.channel-card').filter({ hasText: 'telegram' });
  await telegram.getByRole('button', { name: '配置渠道' }).click();
  const token = page.getByLabel('Telegram Bot Token');
  await expect(token).toHaveValue('');
  await token.fill('synthetic-ui-draft-only');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await telegram.getByRole('button', { name: '配置渠道' }).click();
  await expect(token).toHaveValue('');
  const stored = await page.evaluate(() =>
    JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
  );
  expect(stored).not.toContain('synthetic-ui-draft-only');
  await page.getByRole('button', { name: '取消', exact: true }).click();
});

test('source catalog exposes noncrypto news and fixture prevents adding live feeds', async ({
  page,
}) => {
  await page.goto('/sources');
  await expect(page.getByRole('heading', { name: '来源目录' })).toBeVisible();
  const categories = page.getByLabel('数据源分类');
  await categories.getByRole('button', { name: '科技动态' }).click();
  await expect(page.locator('.source-catalog-list')).toContainText('BBC · 科技动态');
  await categories.getByRole('button', { name: '全球热点' }).click();
  await expect(page.locator('.source-catalog-list')).toContainText('BBC');
  await categories.getByRole('button', { name: '财经市场' }).click();
  await expect(page.locator('.source-catalog-list')).toContainText('BBC · 财经市场');
  const isFixture = await page.getByText('演示数据 · Fixture', { exact: true }).count();
  if (isFixture) {
    await expect(page.getByRole('button', { name: '新增新闻订阅' })).toBeDisabled();
    await expect(page.getByText('当前为 Fixture 演练模式', { exact: false })).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
