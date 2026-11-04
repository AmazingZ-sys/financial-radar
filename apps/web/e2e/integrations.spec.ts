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
    reasoningEffort: await page.getByLabel('推理强度', { exact: true }).inputValue(),
  };
  const name = `UI relay ${Date.now()}`;
  try {
    await page.getByLabel('Provider 名称').fill(name);
    await page.getByLabel('AI 分析', { exact: true }).selectOption('false');
    await page.getByLabel('API Base URL').fill('https://example.com/relay/v1');
    await page.getByLabel('模型名称').fill('ui-model');
    await page.getByLabel('推理强度', { exact: true }).selectOption('high');
    await expect(panel.getByRole('button', { name: '测试 AI 连接' })).toBeDisabled();
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith('/integrations/ai') && response.request().method() === 'PATCH',
    );
    await panel.getByRole('button', { name: '保存 AI 配置' }).click();
    const response = await responsePromise;
    expect(response.ok()).toBe(true);
    const savedBody = await response.json();
    expect(savedBody.data.reasoningEffort).toBe('high');
    expect(response.request().postDataJSON()).toMatchObject({ reasoningEffort: 'high' });
    expect(JSON.stringify(savedBody)).not.toContain('"apiKey":');
    await expect(
      page.getByText('AI 配置已保存，后续分析使用新配置', { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Provider 名称')).toHaveValue(name);
    await expect(page.getByLabel('API Base URL')).toHaveValue('https://example.com/relay/v1');
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('推理强度', { exact: true })).toHaveValue('high');
    await expect(panel.getByText('已保存推理 · High', { exact: true })).toBeVisible();
    await page.getByLabel('推理强度', { exact: true }).selectOption('low');
    await expect(panel.getByRole('button', { name: '测试 AI 连接' })).toBeDisabled();
    await page.reload();
    await expect(page.getByLabel('推理强度', { exact: true })).toHaveValue('high');
  } finally {
    await page.getByLabel('Provider 名称').fill(original.name);
    await page.getByLabel('AI 分析', { exact: true }).selectOption(original.enabled);
    await page.getByLabel('API Base URL').fill(original.baseUrl);
    await page.getByLabel('模型名称').fill(original.model);
    await page.getByLabel('推理强度', { exact: true }).selectOption(original.reasoningEffort);
    await panel.getByRole('button', { name: '保存 AI 配置' }).click();
    await expect(
      page.getByText('AI 配置已保存，后续分析使用新配置', { exact: true }),
    ).toBeVisible();
  }
});

test('AI reasoning UI shows saved XHigh and Low test responses preserve the selection (mock transport)', async ({
  page,
}) => {
  // This exercises UI state only; no real AI provider is contacted.
  await page.route('**/api/v1/integrations/ai', async (route) => {
    expect(route.request().method()).toBe('GET');
    await route.fulfill({
      json: {
        data: {
          name: 'Synthetic UI provider',
          enabled: true,
          baseUrl: 'https://example.com/v1',
          model: 'synthetic-ui-model',
          reasoningEffort: 'xhigh',
          timeoutMs: 20000,
          jsonMode: true,
          dailyBudgetUsd: 1,
          maxCallCostUsd: 0.1,
          apiKeyConfigured: true,
          configOrigin: 'database',
          hasOverride: true,
        },
      },
    });
  });
  let tests = 0;
  await page.route('**/api/v1/integrations/ai/test', async (route) => {
    expect(route.request().method()).toBe('POST');
    tests++;
    await route.fulfill({
      json: {
        data: {
          status: 'skipped',
          message: '测试桩：未调用真实 AI 服务（Low）',
          model: 'synthetic-ui-model',
          reasoningEffort: 'low',
        },
      },
    });
  });
  await page.goto('/system');
  const panel = page.locator('.integration-panel');
  const reasoning = panel.getByLabel('推理强度', { exact: true });
  await expect(reasoning).toHaveValue('xhigh');
  await expect(reasoning.locator('option')).toHaveText(['Low', 'Medium', 'High', 'XHigh']);
  await expect(panel.getByText('已保存推理 · XHigh', { exact: true })).toBeVisible();
  await expect(panel.getByText('连接测试使用最低推理强度 Low', { exact: false })).toBeVisible();
  await panel.getByRole('button', { name: '测试 AI 连接' }).click();
  await expect(panel.getByRole('status')).toHaveText('测试桩：未调用真实 AI 服务（Low）');
  expect(tests).toBe(1);
  await expect(reasoning).toHaveValue('xhigh');
  await expect(panel.getByText('已保存推理 · XHigh', { exact: true })).toBeVisible();
  await reasoning.selectOption('medium');
  await expect(panel.getByRole('button', { name: '测试 AI 连接' })).toBeDisabled();
  await page.reload();
  await expect(reasoning).toHaveValue('xhigh');
  await page.setViewportSize({ width: 390, height: 844 });
  await reasoning.scrollIntoViewIfNeeded();
  await expect(reasoning).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('AI settings stay editable with an older backend until reasoning support is available (mock transport)', async ({
  page,
}) => {
  // The synthetic old server rejects new fields and never calls an AI provider.
  let view = {
    name: 'Synthetic old backend',
    enabled: true,
    baseUrl: 'https://example.com/v1',
    model: 'synthetic-old-model',
    timeoutMs: 20000,
    jsonMode: true,
    dailyBudgetUsd: 1,
    maxCallCostUsd: 0.1,
    apiKeyConfigured: true,
    configOrigin: 'database',
    hasOverride: true,
  };
  let upgraded = false;
  let patchCount = 0;
  let testCount = 0;
  await page.route('**/api/v1/integrations/ai', async (route) => {
    if (route.request().method() === 'PATCH') {
      const patch = route.request().postDataJSON() as Record<string, unknown>;
      if ('reasoningEffort' in patch || 'supportsReasoningEffort' in patch) {
        await route.fulfill({
          status: 400,
          json: {
            error: { code: 'INVALID_INPUT', message: 'Synthetic old server: unknown field' },
          },
        });
        return;
      }
      expect(patch).toMatchObject({
        name: 'Updated legacy provider',
        model: 'updated-legacy-model',
      });
      view = { ...view, name: 'Updated legacy provider', model: 'updated-legacy-model' };
      patchCount++;
    } else {
      expect(route.request().method()).toBe('GET');
    }
    await route.fulfill({
      json: { data: { ...view, ...(upgraded ? { reasoningEffort: 'high' } : {}) } },
    });
  });
  await page.route('**/api/v1/integrations/ai/test', async (route) => {
    testCount++;
    await route.fulfill({
      json: {
        data: { status: 'skipped', message: 'Synthetic old response', model: view.model },
      },
    });
  });
  await page.goto('/system');
  const panel = page.locator('.integration-panel');
  const reasoning = panel.getByLabel('推理强度', { exact: true });
  const connectionTest = panel.getByRole('button', { name: '测试 AI 连接' });
  await expect(reasoning).toBeDisabled();
  await expect(reasoning.locator('option:checked')).toHaveText('等待服务器升级');
  await expect(connectionTest).toBeDisabled();
  await expect(panel.getByText('推理设置待升级', { exact: true })).toBeVisible();
  await expect(panel.getByText('当前服务器尚不支持推理强度', { exact: false })).toBeVisible();
  await expect(panel.getByText('已保存推理', { exact: false })).toHaveCount(0);
  await page.getByLabel('Provider 名称').fill('Updated legacy provider');
  await page.getByLabel('模型名称').fill('updated-legacy-model');
  const patchResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/integrations/ai') && response.request().method() === 'PATCH',
  );
  await panel.getByRole('button', { name: '保存 AI 配置' }).click();
  const response = await patchResponse;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON()).not.toHaveProperty('reasoningEffort');
  expect(response.request().postDataJSON()).not.toHaveProperty('supportsReasoningEffort');
  await expect(page.getByText('AI 配置已保存，后续分析使用新配置', { exact: true })).toBeVisible();
  expect(patchCount).toBe(1);
  await page.reload();
  await expect(page.getByLabel('Provider 名称')).toHaveValue('Updated legacy provider');
  await expect(page.getByLabel('模型名称')).toHaveValue('updated-legacy-model');
  await expect(reasoning).toBeDisabled();
  await expect(connectionTest).toBeDisabled();
  expect(testCount).toBe(0);
  upgraded = true;
  await page.reload();
  await expect(reasoning).toBeEnabled();
  await expect(reasoning).toHaveValue('high');
  await expect(panel.getByText('已保存推理 · High', { exact: true })).toBeVisible();
  await expect(connectionTest).toBeEnabled();
  await expect(panel.getByText('推理设置待升级', { exact: true })).toHaveCount(0);
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

test('source health dialogs remain inside the viewport after scrolling on desktop and mobile', async ({
  page,
}) => {
  for (const viewport of [
    { width: 1280, height: 600 },
    { width: 390, height: 640 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/sources');
    const trigger = page.getByRole('button', { name: '健康记录' }).last();
    await expect(trigger).toBeVisible();
    await page.getByRole('heading', { name: '来源目录' }).scrollIntoViewIfNeeded();
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(async () => {
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    }).toPass();
    await dialog.getByRole('button', { name: '保存周期' }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole('button', { name: '保存周期' })).toBeInViewport();
    await page.screenshot({ path: `.local/usability-test/source-dialog-${viewport.width}.png` });
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
  }
});

test('Gmail setup links are discoverable and long SMTP configuration stays reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto('/notifications');
  const email = page.locator('.channel-card').filter({ hasText: 'email' });
  await expect(email.getByRole('link', { name: 'Gmail SMTP 官方说明' })).toHaveAttribute(
    'href',
    /google\.com/,
  );
  await expect(email.getByRole('link', { name: '创建应用专用密码' })).toHaveAttribute(
    'href',
    'https://myaccount.google.com/apppasswords',
  );
  await email.getByRole('button', { name: '配置渠道' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Gmail / Google Workspace 设置帮助', { exact: true }).click();
  await expect(dialog.getByRole('link', { name: '开启两步验证' })).toHaveAttribute(
    'href',
    /myaccount\.google\.com/,
  );
  const save = dialog.getByRole('button', { name: '保存渠道配置' });
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  const box = await dialog.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(640);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

test('source setup exposes official portals and clears unsaved credential drafts', async ({
  page,
}) => {
  await page.goto('/sources');
  const panel = page.locator('#source-connections');
  await expect(panel.getByRole('heading', { name: '数据源接入设置' })).toBeVisible();
  for (const name of ['UniSat', 'Ethereum RPC', 'Solana RPC', 'DEX Screener'])
    await expect(panel.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(panel.getByRole('link', { name: '申请 API Key' })).toHaveAttribute(
    'href',
    'https://developer.unisat.io',
  );
  await expect(panel.getByRole('link', { name: '创建 RPC 端点' })).toHaveCount(2);
  await panel.getByRole('button', { name: '编辑连接设置' }).click();
  await panel.getByLabel('UniSat API Key', { exact: true }).fill('synthetic-source-draft');
  await panel
    .getByLabel('Ethereum RPC URL', { exact: true })
    .fill('https://example.com/synthetic-draft');
  await panel.getByRole('button', { name: '取消', exact: true }).click();
  await panel.getByRole('button', { name: '编辑连接设置' }).click();
  await expect(panel.getByLabel('UniSat API Key', { exact: true })).toHaveValue('');
  await expect(panel.getByLabel('Ethereum RPC URL', { exact: true })).toHaveValue('');
  await expect(panel.getByLabel('DEX Token 地址')).toBeVisible();
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toContain('synthetic-source-draft');
  await page.setViewportSize({ width: 390, height: 640 });
  await panel.getByRole('button', { name: '保存数据源配置' }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('dashboard commodity cards open the matching market without inventing fixture quotes', async ({
  page,
}) => {
  await page.goto('/');
  const panel = page.locator('.commodity-monitor');
  await expect(panel.getByRole('heading', { name: '黄金与原油' })).toBeVisible();
  const response = await page.request.get('/api/v1/markets/assets');
  const assets = (await response.json()) as {
    data: { asset: string; value: number | null; sourceId: string; dataMode: string }[];
  };
  for (const symbol of ['XAU', 'WTI']) {
    const quote = assets.data.find((item) => item.asset === symbol);
    expect(quote).toBeDefined();
    if (quote?.value === null)
      await expect(
        panel.locator(`.commodity-quote[href="/markets?asset=${symbol}"]`),
      ).toContainText('暂无观测');
  }
  await panel.locator('.commodity-quote[href="/markets?asset=WTI"]').click();
  await expect(page).toHaveURL(/\/markets\?asset=WTI$/);
  await expect(page.locator('.market-card.selected .market-symbol')).toHaveText('WTI');
  await expect(page.locator('.segmented button.active')).toHaveText('30 天');
});
