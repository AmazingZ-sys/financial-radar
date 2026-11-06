<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ZodError } from 'zod';
import {
  DEFAULT_X_CONFIG,
  XConfigSchema,
  XConfigViewSchema,
  XConnectionTestSchema,
  type XConfigView,
  type XConnectionTest,
} from '@radar/shared';
import { api, ApiError, write } from '../lib/api';
import { date, number } from '../lib/format';
import RadarIcon from './RadarIcon.vue';
import StatusBadge from './StatusBadge.vue';

const client = useQueryClient();
const { data, isPending, error, refetch } = useQuery({
  queryKey: ['x-integration'],
  queryFn: () => api('/integrations/x', {}, XConfigViewSchema),
  refetchInterval: 30000,
});
const current = computed(() => data.value?.data);
const unavailable = computed(() => error.value instanceof ApiError && error.value.status === 404);
const form = reactive({ ...DEFAULT_X_CONFIG, usernames: '', keywords: '' });
const sessionCookies = ref('');
const clearSessionCookies = ref(false);
const saved = ref('');
const dirty = computed(
  () =>
    JSON.stringify(form) !== saved.value ||
    Boolean(sessionCookies.value) ||
    clearSessionCookies.value,
);
const saving = ref(false);
const testing = ref(false);
const saveError = ref('');
const testError = ref('');
const result = ref<XConnectionTest | null>(null);
function reset(value: XConfigView) {
  Object.assign(form, {
    ...XConfigSchema.parse(value),
    usernames: value.usernames.join('\n'),
    keywords: value.keywords.join('\n'),
  });
  sessionCookies.value = '';
  clearSessionCookies.value = false;
  saved.value = JSON.stringify(form);
}
watch(
  data,
  (value) => {
    if (value && (!saved.value || !dirty.value)) reset(value.data);
  },
  { immediate: true },
);
watch(clearSessionCookies, (value) => {
  if (value) {
    sessionCookies.value = '';
    form.enabled = false;
  }
});
onBeforeUnmount(() => {
  sessionCookies.value = '';
});
const split = (value: string) =>
  value
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
const projectedReads = computed(() => Number(form.maxResults) * Number(form.dailyRequestLimit));
const diagnostic = computed(() => result.value ?? current.value?.lastTest);
async function save() {
  saving.value = true;
  saveError.value = '';
  result.value = null;
  testError.value = '';
  try {
    const fields = XConfigSchema.parse({
      ...form,
      usernames: split(form.usernames),
      keywords: split(form.keywords),
    });
    const response = await write<XConfigView>('/integrations/x', 'PATCH', {
      ...fields,
      ...(sessionCookies.value ? { sessionCookies: sessionCookies.value } : {}),
      ...(clearSessionCookies.value ? { clearSessionCookies: true } : {}),
    });
    reset(XConfigViewSchema.parse(response.data));
    await client.invalidateQueries({ queryKey: ['x-integration'] });
    await client.invalidateQueries({ queryKey: ['sources'] });
    await client.invalidateQueries({ queryKey: ['audit-logs'] });
  } catch (cause) {
    saveError.value =
      cause instanceof ZodError
        ? cause.issues.map((issue) => issue.message).join('；')
        : cause instanceof Error
          ? cause.message
          : 'X 配置保存失败';
  } finally {
    sessionCookies.value = '';
    saving.value = false;
  }
}
async function testConnection() {
  testing.value = true;
  testError.value = '';
  result.value = null;
  try {
    result.value = (
      await api(
        '/integrations/x/test',
        { method: 'POST', signal: AbortSignal.timeout(30000) },
        XConnectionTestSchema,
      )
    ).data;
    await client.invalidateQueries({ queryKey: ['x-integration'] });
  } catch (cause) {
    testError.value = cause instanceof Error ? cause.message : 'X 连接测试失败';
  } finally {
    testing.value = false;
  }
}
</script>
<template>
  <section id="x-integration" class="panel detail-panel x-integration">
    <div class="panel-heading">
      <div>
        <div class="eyebrow">X · RESEARCH INTAKE</div>
        <h2>X 讨论监测</h2>
      </div>
      <span class="badge" :class="current?.source.enabled ? 'badge-healthy' : 'badge-unknown'">{{
        current?.dataMode === 'fixture'
          ? 'Fixture · 不访问 X'
          : current?.source.enabled
            ? '采集已启用'
            : '采集已关闭'
      }}</span>
    </div>
    <p class="muted text-sm">
      自建免费采集 · 无数据 API 费用。先汇聚多位作者的原创讨论，再按 AI
      日额度研究；单条帖子不自动调用 AI。
    </p>
    <div class="x-layout">
      <aside class="x-guide">
        <h3>免费自建接入步骤</h3>
        <ol>
          <li>
            按仓库
            <code>services/x-collector/README.md</code>
            更新服务器部署文件并执行一键部署，自动启动采集器、配置共享密钥，无需另装 Python。
          </li>
          <li>
            在浏览器登录你自己授权的 X 账号，打开开发者工具 → Application（应用）→ Cookies →
            <code>https://x.com</code>。
          </li>
          <li>
            找到 <code>auth_token</code> 和 <code>ct0</code>，在右侧以
            <code>auth_token=值; ct0=值</code> 格式填写。不要发送到聊天或放进链接。
          </li>
          <li>保存登录态、关注账号和采集范围，先保持采集关闭。</li>
          <li>点击连接测试，查看真实样本或失败原因。测试仅使用自建采集器，不调用 AI。</li>
          <li>测试后启用；遇到登录失效时重新登录并更新这两个值，限流时等待冷却。</li>
        </ol>
        <details class="x-deploy">
          <summary>服务器首次部署</summary>
          <p class="muted text-xs">
            先按仓库部署文档，将服务器代码更新到包含采集器镜像的已发布版本，保留现有环境配置与数据卷。之后在项目目录执行：
          </p>
          <pre class="x-query">sudo bash infra/scripts/deploy.sh</pre>
          <p class="muted text-xs">
            脚本拉取同版本的 API、Worker 和采集器镜像。共享密钥未配置时自动生成，保存在服务器
            .deploy/x-collector.secret；它不是 X 登录态。采集器仅使用 Docker
            内网8080，不占用宿主8888。授权登录态在此填写，更新后无需重建容器。
          </p>
        </details>
        <div class="notice-box">
          <RadarIcon name="shield" :size="16" />
          <p>
            登录态仅在服务器加密保存。无数据 API
            费用，需使用已有服务器资源；可能限流、掉登录或漏帖。讨论采样不代表全网趋势或项目官方确认。
          </p>
        </div>
        <div class="x-links">
          <a href="https://github.com/vladkens/twscrape" target="_blank" rel="noopener noreferrer"
            >开源采集器文档 ↗</a
          >
          <RouterLink to="/sources">查看数据源状态 →</RouterLink>
          <RouterLink to="/events">查看事件与研究结果 →</RouterLink>
        </div>
      </aside>
      <div class="x-controls">
        <div v-if="isPending" class="empty-inline">正在读取 X 配置…</div>
        <div v-else-if="error" class="notice-box">
          <p>
            {{
              unavailable
                ? '当前后端尚未提供 X 接入管理，更新后可在这里配置。接入步骤可先查看。'
                : error.message
            }}
          </p>
          <button class="btn" @click="refetch()">重新读取</button>
        </div>
        <template v-else-if="current">
          <div class="x-state-strip">
            <div>
              <span>今日请求 / 上限（UTC）</span
              ><b class="mono"
                >{{ number(current.usage.requests) }} / {{ number(current.dailyRequestLimit) }}</b
              >
            </div>
            <div>
              <span>最近采集</span><b>{{ date(current.source.lastFetchedAt) }}</b>
            </div>
            <div>
              <span>X 登录态</span
              ><b>{{
                current.credentialError
                  ? '无法解密 · 请重新保存'
                  : current.sessionConfigured
                    ? '已加密保存'
                    : '未配置'
              }}</b>
            </div>
          </div>
          <div class="x-scheduling" aria-label="X 采集调度">
            <div>
              <span>已保存采集区间</span>
              <b class="mono" data-testid="x-saved-interval"
                >{{ number(current.pollIntervalMinSeconds) }}–{{
                  number(current.pollIntervalMaxSeconds)
                }}
                秒</b
              >
            </div>
            <div>
              <span>下一次允许请求</span>
              <b data-testid="x-next-request"
                ><time
                  v-if="current.scheduling.nextRequestAt"
                  :datetime="current.scheduling.nextRequestAt"
                  >{{ date(current.scheduling.nextRequestAt, true) }}</time
                ><template v-else>尚未预留真实请求</template></b
              >
            </div>
            <div>
              <span>最近抽取间隔</span>
              <b class="mono" data-testid="x-last-delay">{{
                current.scheduling.lastDelaySeconds === null
                  ? '尚未抽取'
                  : `${number(current.scheduling.lastDelaySeconds)} 秒`
              }}</b>
            </div>
            <p class="muted text-xs">
              每次实际请求时，从已保存区间随机抽取下一次等待时间。连接测试与自动采集共用等待；保存配置不会重置已安排的等待，平台限流可能进一步延后请求。
            </p>
          </div>
          <div v-if="!current.collectorConfigured" class="notice-box">
            <p>
              服务器采集器尚未配置：请更新服务器部署文件并运行一键部署脚本，自动启动采集器并配置共享密钥。
            </p>
          </div>
          <div v-if="current.source.lastError" class="form-error">
            最近采集：{{ current.source.lastError }}
          </div>
          <form class="form-grid" @submit.prevent="save">
            <div class="form-field full">
              <label class="checkbox-label"
                ><input
                  v-model="form.enabled"
                  type="checkbox"
                  :disabled="clearSessionCookies"
                />启用 X 自动采集</label
              ><span class="muted text-xs">保存后供后续任务使用；Fixture 模式仍不会访问 X。</span>
            </div>
            <div class="form-field full">
              <label for="x-session-cookies">X 登录态（auth_token 和 ct0）</label
              ><input
                id="x-session-cookies"
                v-model="sessionCookies"
                type="password"
                autocomplete="new-password"
                :disabled="clearSessionCookies"
                :placeholder="
                  current.sessionConfigured
                    ? '已保存，留空保留；填写可更新登录态'
                    : 'auth_token=你的值; ct0=你的值'
                "
                maxlength="4096"
              /><label class="checkbox-label"
                ><input v-model="clearSessionCookies" type="checkbox" />清除已保存
                登录态，并关闭采集</label
              >
            </div>
            <div class="form-field">
              <label for="x-usernames">关注账号</label
              ><textarea
                id="x-usernames"
                v-model="form.usernames"
                rows="4"
                placeholder="每行一个用户名，可带 @；最多20个"
              /><span class="muted text-xs">只填写用户名，无需填写个人主页链接。</span>
            </div>
            <div class="form-field">
              <label for="x-keywords">关键词（可选）</label
              ><textarea
                id="x-keywords"
                v-model="form.keywords"
                rows="4"
                placeholder="每行一个词；留空观察这些账号的全部原创讨论"
              /><span class="muted text-xs">最多10项，按字面词搜索；不填写高级搜索操作符。</span>
            </div>
            <div class="form-field">
              <label for="x-poll-min">最短采集间隔（秒）</label
              ><input
                id="x-poll-min"
                v-model.number="form.pollIntervalMinSeconds"
                type="number"
                min="300"
                max="86400"
                step="1"
                required
              />
            </div>
            <div class="form-field">
              <label for="x-poll-max">最长采集间隔（秒）</label
              ><input
                id="x-poll-max"
                v-model.number="form.pollIntervalMaxSeconds"
                type="number"
                min="300"
                max="86400"
                step="1"
                required
              />
            </div>
            <div class="form-field">
              <label for="x-page-size">每页最多帖子</label
              ><input
                id="x-page-size"
                v-model.number="form.maxResults"
                type="number"
                min="10"
                max="100"
                step="1"
                required
              />
            </div>
            <div class="form-field">
              <label for="x-daily-limit">X 每日请求上限</label
              ><input
                id="x-daily-limit"
                v-model.number="form.dailyRequestLimit"
                type="number"
                min="0"
                max="500"
                step="1"
                required
              /><span class="muted text-xs">测试和失败请求也计次；0停止请求，UTC日重置。</span>
            </div>
            <div class="form-field">
              <label for="x-min-authors">研究候选最少作者数</label
              ><input
                id="x-min-authors"
                v-model.number="form.candidateMinAuthors"
                type="number"
                min="2"
                max="20"
                step="1"
                required
              />
            </div>
            <div class="form-field">
              <label for="x-topic-window">讨论聚合窗口（分钟）</label
              ><input
                id="x-topic-window"
                v-model.number="form.candidateWindowMinutes"
                type="number"
                min="15"
                max="60"
                step="1"
                required
              />
            </div>
            <div class="form-field full">
              <p class="muted text-xs">
                按当前草稿，每日最多返回 {{ number(projectedReads) }} 条帖子（请求上限 ×
                每页数量），实际可能更少；请求数用于控制负载，不是付费额度。
              </p>
              <details>
                <summary>查看已保存的搜索范围</summary>
                <code class="x-query">{{ current.query || '保存至少一个关注账号后生成查询' }}</code>
              </details>
            </div>
            <div v-if="saveError" class="form-error full" role="alert">{{ saveError }}</div>
            <div class="dialog-actions full">
              <span v-if="dirty" class="muted text-xs">有未保存修改；测试使用已保存配置</span
              ><button
                class="btn"
                type="button"
                :disabled="saving || testing || dirty"
                @click="testConnection"
              >
                {{ testing ? '正在测试…' : '测试 X 连接' }}</button
              ><button class="btn btn-primary" type="submit" :disabled="saving || testing">
                {{ saving ? '保存中…' : '保存 X 配置' }}</button
              ><button
                class="btn"
                type="button"
                :disabled="saving || testing"
                @click="reset(current)"
              >
                放弃修改
              </button>
            </div>
          </form>
          <div v-if="testError" class="form-error" role="alert">{{ testError }}</div>
          <section v-if="diagnostic" class="x-diagnostic" aria-label="X 连接测试结果">
            <div class="panel-heading">
              <h3>最近连接测试</h3>
              <StatusBadge
                :value="
                  diagnostic.status === 'connected'
                    ? 'SUCCESS'
                    : diagnostic.status === 'failed'
                      ? 'FAILED'
                      : 'SKIPPED'
                "
              />
            </div>
            <p>{{ diagnostic.message }}</p>
            <p class="muted text-xs">
              {{ date(diagnostic.checkedAt) }} · 返回 {{ number(diagnostic.returnedPosts) }} 条<span
                v-if="diagnostic.httpStatus"
              >
                · HTTP {{ diagnostic.httpStatus }}</span
              >
              · 测试样本不入研究队列
            </p>
            <article v-for="sample in diagnostic.samples" :key="sample.id" class="x-sample">
              <a :href="sample.url" target="_blank" rel="noopener noreferrer">{{ sample.text }}</a>
              <p class="muted text-xs">
                作者 ID {{ sample.authorId }} · 来源时间 {{ date(sample.sourcePublishedAt) }}
              </p>
            </article>
          </section>
        </template>
      </div>
    </div>
  </section>
</template>
<style scoped>
.x-integration {
  margin-top: 24px;
}
.x-layout {
  display: grid;
  grid-template-columns: minmax(240px, 0.7fr) minmax(0, 1.3fr);
  gap: 32px;
  margin-top: 24px;
}
.x-guide {
  border-right: 1px solid var(--border);
  padding-right: 28px;
  min-width: 0;
}
.x-guide ol {
  list-style: decimal;
  padding-left: 20px;
  display: grid;
  gap: 16px;
  margin: 20px 0;
  font-size: 13px;
  line-height: 1.8;
}
.x-guide a,
.x-links a,
.x-sample a {
  color: var(--teal);
}
.x-links {
  display: grid;
  gap: 12px;
  margin-top: 24px;
  font-size: 12px;
}
.x-controls {
  min-width: 0;
}
.x-controls textarea {
  min-height: 100px;
  resize: vertical;
}
.x-state-strip,
.x-scheduling {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  padding-bottom: 20px;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--border);
}
.x-state-strip span,
.x-scheduling span {
  display: block;
  color: var(--muted);
  font-size: 11px;
  margin-bottom: 8px;
}
.x-state-strip b,
.x-scheduling b {
  font-size: 13px;
  overflow-wrap: anywhere;
}
.x-scheduling p {
  grid-column: 1 / -1;
  margin: 0;
  line-height: 1.8;
}
.x-query {
  display: block;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin-top: 12px;
  font-size: 12px;
}
.x-diagnostic {
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--border);
  font-size: 13px;
}
.x-sample {
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
  overflow-wrap: anywhere;
}
.x-sample a {
  display: block;
  line-height: 1.7;
}
@media (max-width: 1000px) {
  .x-layout {
    grid-template-columns: 1fr;
  }
  .x-guide {
    border-right: 0;
    border-bottom: 1px solid var(--border);
    padding-right: 0;
    padding-bottom: 24px;
  }
}
@media (max-width: 520px) {
  .x-state-strip,
  .x-scheduling {
    grid-template-columns: 1fr;
  }
}
</style>
