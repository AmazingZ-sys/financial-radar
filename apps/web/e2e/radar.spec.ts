import { expect, test, type BrowserContext } from '@playwright/test';

const email = process.env.E2E_ADMIN_EMAIL ?? process.env.ADMIN_EMAIL ?? 'admin@radar.local';
const password =
  process.env.E2E_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? 'change-me-local-only';

let authenticatedState: Awaited<ReturnType<BrowserContext['storageState']>>;
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto(process.env.E2E_BASE_URL ?? 'http://localhost:5173');
  await page.getByLabel('管理员邮箱').fill(email);
  await page.getByLabel('登录密码').fill(password);
  await page.getByRole('button', { name: '登录工作台' }).click();
  await expect(page.getByRole('heading', { name: '雷达总览.' })).toBeVisible();
  authenticatedState = await page.context().storageState();
  await page.close();
});
test.beforeEach(async ({ context, page }) => {
  await context.addCookies(authenticatedState.cookies);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '雷达总览.' })).toBeVisible();
});

test('fixture is explicit and evidence pages use the real API', async ({ page }) => {
  await expect(page.getByText('演示数据 · Fixture', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: '早期机会 CORE', exact: true }).click();
  await expect(page.getByRole('heading', { name: '早期机会.' })).toBeVisible();
  const project = page.locator('.project-card').first();
  await expect(project).toBeVisible();
  await project.click();
  await expect(page.getByRole('heading', { name: '发现时间线' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '评分与解释' })).toBeVisible();
  await page.getByRole('link', { name: '实时热点', exact: true }).click();
  await page.locator('.event-row').first().click();
  await expect(page.getByRole('heading', { name: '来源与证据' })).toBeVisible();
  const payload = page.locator('details').filter({ hasText: '展开原始 payload' }).first();
  await payload.locator('summary').click();
  await expect(payload.locator('pre')).toContainText('chain-fixture');
  await expect(page.locator('.detail-side')).toContainText('评分解释');
});

test('rules are persisted through create edit test and delete', async ({ page }) => {
  const ruleName = `E2E规则-${Date.now()}`;
  await page.getByRole('link', { name: '预警规则', exact: true }).click();
  await page.getByRole('button', { name: '新建规则' }).click();
  await expect(page.getByLabel('最低置信度（%）')).toHaveValue('80');
  await expect(page.getByLabel('最低机会评分')).toHaveValue('65');
  await expect(page.getByLabel('最高风险评分')).toHaveValue('60');
  await expect(page.getByLabel('冷却时间（秒）')).toHaveValue('86400');
  await expect(page.getByLabel('只匹配已验证来源', { exact: true })).toBeChecked();
  await expect(page.getByLabel('包含行情快照', { exact: true })).not.toBeChecked();
  await page.getByLabel('规则名称').fill(ruleName);
  await page.getByRole('button', { name: '保存规则' }).click();
  const card = page
    .locator('.rule-card')
    .filter({ has: page.getByRole('heading', { name: new RegExp(ruleName) }) });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '测试规则' }).click();
  await expect(page.locator('.json-view')).toContainText('matched');
  await page.keyboard.press('Escape');
  await card.getByRole('button', { name: `编辑${ruleName}` }).click();
  await page.getByLabel('最低机会评分').fill('72');
  await page.getByLabel('新项目来源 ID（逗号分隔，可空）').fill('chain-fixture');
  await page.getByRole('button', { name: '保存规则' }).click();
  await expect(card).toContainText('72');
  await page.reload();
  await expect(card).toContainText('72');
  await expect(card).toContainText('chain-fixture');
  await card.getByRole('button', { name: `删除${ruleName}` }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(card).toHaveCount(0);
});

test('theme and responsive navigation stay usable', async ({ page }) => {
  await page.getByRole('button', { name: '切换浅色主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开导航' }).click();
  await page.getByRole('link', { name: '数据源', exact: true }).click();
  await expect(page.getByRole('heading', { name: '数据源.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('unconfigured notification credentials are shown without exposing secrets', async ({
  page,
}) => {
  await page.getByRole('link', { name: '通知中心', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: '推送渠道' })).toBeVisible();
  await expect(
    page.getByText('“平台已接受”表示渠道 API 确认接收请求', { exact: false }),
  ).toBeVisible();
  await page.getByRole('link', { name: '系统管理', exact: true }).click();
  await expect(page.getByRole('heading', { name: '凭据配置状态' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI Provider 配置' })).toBeVisible();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
});

test('calendar separates unknown values from publication confirmation', async ({ page }) => {
  await page.getByRole('link', { name: '经济日历', exact: true }).click();
  await expect(page.getByRole('heading', { name: '经济日历.' })).toBeVisible();
  await expect(page.locator('.calendar-table')).toBeVisible();
  await expect(page.locator('.calendar-table')).toContainText('Fixture');
  await expect(page.locator('.calendar-table')).toContainText('未知');
  await expect(page.locator('.calendar-table')).toContainText('待确认');
});

test('personal timezone is saved and used after a full reload', async ({ page }) => {
  await page.getByRole('link', { name: '系统管理', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存设置' })).toBeEnabled();
  await page.getByLabel('显示时区').selectOption('UTC');
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByText('个人设置已保存', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('显示时区')).toHaveValue('UTC');
  await expect(page.locator('.topbar-clock')).toContainText('UTC');
  await page.getByLabel('显示时区').selectOption('Asia/Shanghai');
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByText('个人设置已保存', { exact: true })).toBeVisible();
});

test('scoring editor keeps used versions immutable', async ({ page }) => {
  await page.getByRole('link', { name: '系统管理', exact: true }).click();
  await page.locator('.advanced-panel summary').click();
  const editor = page.getByLabel('评分配置 JSON');
  await expect(editor).not.toHaveValue('');
  const config = JSON.parse(await editor.inputValue()) as {
    opportunity: { version: string; weights: { sourceTrust: number } };
    risk: { version: string };
  };
  const initialWeight = config.opportunity.weights.sourceTrust;
  config.opportunity.weights.sourceTrust = initialWeight + 1;
  await editor.fill(JSON.stringify(config, null, 2));
  const rejected = page.waitForResponse(
    (response) =>
      response.url().endsWith('/system/scoring') && response.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: '保存评分新版本' }).click();
  expect((await rejected).status()).toBe(409);
  await expect(page.locator('.advanced-body .form-error')).toBeVisible();
  config.opportunity.version = `e2e-${Date.now()}`;
  await editor.fill(JSON.stringify(config, null, 2));
  const savedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/system/scoring') && response.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: '保存评分新版本' }).click();
  const saved = await savedResponse;
  expect(saved.status()).toBe(200);
  expect((await saved.json()).data.opportunity).toMatchObject(config.opportunity);
  await expect(
    page.getByText('评分配置新版本已保存，历史评分保留原版本', { exact: true }).last(),
  ).toBeVisible();
  config.opportunity.weights.sourceTrust = initialWeight;
  config.opportunity.version = `e2e-restored-${Date.now()}`;
  await editor.fill(JSON.stringify(config, null, 2));
  const restoredResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith('/system/scoring') && response.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: '保存评分新版本' }).click();
  const restored = await restoredResponse;
  expect(restored.status()).toBe(200);
  expect((await restored.json()).data.opportunity).toMatchObject(config.opportunity);
  await expect(
    page.getByText('评分配置新版本已保存，历史评分保留原版本', { exact: true }).last(),
  ).toBeVisible();
  await page.reload();
  await page.locator('.advanced-panel summary').click();
  await expect(editor).not.toHaveValue('');
  expect(JSON.parse(await editor.inputValue()).opportunity).toMatchObject(config.opportunity);
});

test('network failure presents retry and recovers from the real API', async ({ page }) => {
  await page.route('**/api/v1/events?**', (route) => route.abort('failed'));
  await page.getByRole('link', { name: '实时热点', exact: true }).click();
  await expect(page.getByRole('heading', { name: '实时热点.' })).toBeVisible();
  await expect(page.getByText('数据暂时不可用', { exact: true })).toBeVisible();
  await expect(page.locator('.event-row')).toHaveCount(0);
  await page.unroute('**/api/v1/events?**');
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect(page.locator('.event-row').first()).toBeVisible();
  await expect(page.getByText('数据暂时不可用', { exact: true })).toHaveCount(0);
});

test('fixture connector can be disabled and restored without losing its history', async ({
  page,
}) => {
  await page.getByRole('link', { name: '数据源', exact: true }).click();
  const card = page.locator('.source-card').filter({ hasText: 'chain-fixture' });
  await expect(card).toHaveCount(1);
  const control = card.getByRole('switch');
  const original = await control.getAttribute('aria-checked');
  try {
    await card.locator('.el-switch').click();
    await expect(control).toHaveAttribute('aria-checked', original === 'true' ? 'false' : 'true');
    await page.reload();
    await expect(control).toHaveAttribute('aria-checked', original === 'true' ? 'false' : 'true');
  } finally {
    if ((await control.getAttribute('aria-checked')) !== original)
      await card.locator('.el-switch').click();
  }
  await expect(control).toHaveAttribute('aria-checked', original ?? 'true');
});

test('human review is saved independently of fact verification and scores', async ({ page }) => {
  await page.getByRole('link', { name: '实时热点', exact: true }).click();
  await page.locator('.event-row').first().click();
  const before = await page.locator('.detail-side').innerText();
  await page.getByLabel('复核说明（可选）').fill('E2E 人工核对：仅评审辅助解读，不改变来源事实。');
  await page.getByRole('button', { name: '通过复核', exact: true }).click();
  await expect(page.getByText('人工已通过', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('人工已通过', { exact: true })).toBeVisible();
  await expect(page.locator('.review-record')).toContainText('E2E 人工核对');
  expect(await page.locator('.detail-side').innerText()).toBe(before);
});
