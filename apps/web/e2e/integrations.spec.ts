import { expect, test, type BrowserContext } from '@playwright/test';
import { NotificationConfigViewSchema } from '@radar/shared';

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

test('email SMTP configuration persists safely and queues only fixture test messages', async ({
  page,
}) => {
  await page.goto('/notifications');
  const listResponse = await page.request.get('/api/v1/notification-channels');
  expect(listResponse.ok()).toBe(true);
  const list = (await listResponse.json()) as {
    data: unknown[];
    meta: { dataMode: string };
  };
  test.skip(list.meta.dataMode !== 'fixture', 'SMTP configuration test requires fixture mode');
  const original = list.data
    .map((channel) => NotificationConfigViewSchema.parse(channel))
    .find((channel) => channel.provider === 'email');
  expect(original).toBeDefined();
  if (!original) return;
  test.skip(original.smtpPasswordConfigured, 'Preserve existing SMTP credentials');
  const me = await page.request.get('/api/v1/auth/me');
  const session = (await me.json()) as { data: { csrfToken: string } };
  const headers = {
    Origin: new URL(page.url()).origin,
    'X-CSRF-Token': session.data.csrfToken,
  };
  const email = page.locator('.channel-card').filter({ hasText: 'email' });
  const secret = 'synthetic-ui-smtp-only';
  const name = `UI email ${Date.now()}`;
  try {
    await expect(page.locator('.channel-card')).toHaveCount(4);
    await email.getByRole('button', { name: '配置渠道' }).click();
    await page.getByLabel('渠道名称').fill(name);
    await page.getByLabel('渠道状态').selectOption('true');
    await page.getByLabel('SMTP 服务器').fill('smtp.example.com');
    await page.getByLabel('SMTP 端口').fill('2525');
    await page.getByLabel('加密方式').selectOption('starttls');
    await page.getByLabel('SMTP 用户名').fill('alerts@example.com');
    await page.getByLabel('SMTP 密码').fill(secret);
    await page.getByLabel('发件人地址').fill('alerts@example.com');
    await page.getByLabel('收件人地址').fill('admin@example.com; ops@example.com');
    const saveResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/notification-channels/${original.id}`) &&
        response.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: '保存渠道配置' }).click();
    const saved = await saveResponse;
    expect(saved.ok()).toBe(true);
    const savedBody = await saved.json();
    expect(savedBody.data).toMatchObject({
      provider: 'email',
      configured: true,
      configOrigin: 'database',
      smtpHost: 'smtp.example.com',
      smtpPort: 2525,
      smtpSecurity: 'starttls',
      smtpPasswordConfigured: true,
      toEmails: ['admin@example.com', 'ops@example.com'],
    });
    expect(savedBody.data).not.toHaveProperty('smtpPassword');
    expect(JSON.stringify(savedBody)).not.toContain(secret);
    await expect(page.getByText('通知渠道配置已保存，后续发送使用新配置')).toBeVisible();
    await page.reload();
    await email.getByRole('button', { name: '配置渠道' }).click();
    await expect(page.getByLabel('SMTP 端口')).toHaveValue('2525');
    await expect(page.getByLabel('加密方式')).toHaveValue('starttls');
    await expect(page.getByLabel('收件人地址')).toHaveValue('admin@example.com, ops@example.com');
    await expect(page.getByLabel('SMTP 密码')).toHaveValue('');
    await page.getByLabel('渠道名称').fill(`${name} edited`);
    const editResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/notification-channels/${original.id}`) &&
        response.request().method() === 'PATCH',
    );
    await page.getByRole('button', { name: '保存渠道配置' }).click();
    const edited = await editResponse;
    expect(edited.request().postDataJSON()).not.toHaveProperty('smtpPassword');
    expect((await edited.json()).data.smtpPasswordConfigured).toBe(true);
    await expect(page.getByText('通知渠道配置已保存，后续发送使用新配置')).toBeVisible();
    await email.getByRole('button', { name: '配置渠道' }).click();
    await page.getByLabel('SMTP 密码').fill('unsubmitted-smtp-draft');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await email.getByRole('button', { name: '配置渠道' }).click();
    await expect(page.getByLabel('SMTP 密码')).toHaveValue('');
    const stored = await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    );
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain('unsubmitted-smtp-draft');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    const testResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/notification-channels/test') &&
        response.request().method() === 'POST',
    );
    await email.getByRole('button', { name: '发送测试' }).click();
    const queued = await testResponse;
    expect(queued.status()).toBe(202);
    const queuedId = (await queued.json()).data.id as string;
    const historyResponse = await page.request.get('/api/v1/notifications?pageSize=50');
    const history = (await historyResponse.json()) as {
      data: { id: string; dataMode: string; status: string; acceptedAt: string | null }[];
      meta: { dataMode: string };
    };
    expect(history.meta.dataMode).toBe('fixture');
    const message = history.data.find((notification) => notification.id === queuedId);
    expect(message).toMatchObject({ dataMode: 'fixture', acceptedAt: null });
    expect(message?.status).not.toBe('SENT');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(email).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await email.getByRole('button', { name: '配置渠道' }).click();
    await expect(page.getByLabel('SMTP 服务器')).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  } finally {
    await page.request.patch(`/api/v1/notification-channels/${original.id}`, {
      headers,
      data: { name: original.name, enabled: original.enabled, clearCredentials: true },
    });
    if (original.configured)
      await page.request.patch(`/api/v1/notification-channels/${original.id}`, {
        headers,
        data: {
          smtpHost: original.smtpHost,
          smtpPort: original.smtpPort,
          smtpSecurity: original.smtpSecurity,
          smtpUsername: original.smtpUsername,
          fromEmail: original.fromEmail,
          toEmails: original.toEmails,
        },
      });
  }
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
