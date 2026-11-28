<script setup lang="ts">
import { computed, ref } from 'vue'

const props = defineProps<{
  kind: 'provider-routing' | 'privacy-shield' | 'site-rules-priority'
  en: boolean
}>()

const t = (zh: string, english: string) => (props.en ? english : zh)

/* 1. 翻译服务类型切换 */
type ProviderTier = 'free' | 'cloud' | 'ai' | 'local'
const providerTier = ref<ProviderTier>('free')

const providerTiers = computed(() => [
  {
    key: 'free' as const,
    label: t('免费翻译池', 'Free pool'),
    pros: t('零配置开箱即用，支持自动均衡与失败切线，适合日常浏览。', 'Zero setup out of the box with auto load-balancing and fallback across free nodes.'),
    tradeoff: t('免费网页接口可能限流或波动，各候选服务的数据政策分别适用。', 'Public web endpoints may throttle or vary; each candidate provider’s privacy policy applies.'),
    examples: ['Google', 'Microsoft', 'Bilibili', 'DeepLX', 'MyMemory'],
  },
  {
    key: 'cloud' as const,
    label: t('传统与云厂商 API', 'Classic & Cloud APIs'),
    pros: t('速度稳定、支持多段合批（Google / 微软 / DeepL / Azure / 谷歌云），适合高频文档与长文。', 'Fast, reliable, and supports segment batching (Google / Microsoft / DeepL / Azure / Google Cloud).'),
    tradeoff: t('需在对应云控制台开通并填写密钥，按字符计费。', 'Requires provider console credentials; billed per character.'),
    examples: ['DeepL Free/Pro', 'Google Cloud', 'Azure', t('阿里云 / 腾讯云 / 百度 / 火山', 'Alibaba / Tencent / Baidu / Volcengine')],
  },
  {
    key: 'ai' as const,
    label: t('通用 AI 大模型', 'AI Models'),
    pros: t('理解复杂语境与专业表达，支持 AI 精翻、AI 多段翻译、划词深度讲解与写作助手。', 'Strong nuance & context understanding; powers AI Context, multi-segment AI, deep explanations & writing.'),
    tradeoff: t('响应较机器翻译慢，按 Token 计费，需配置 API Key 与模型 ID。', 'Slower than MT, billed by tokens, requires API key & model ID.'),
    examples: ['OpenAI', 'DeepSeek', 'Claude', 'Gemini', t('OpenAI 兼容接口', 'OpenAI-compatible')],
  },
  {
    key: 'local' as const,
    label: t('本机离线模型', 'Local & Offline'),
    pros: t('待译正文全程留在本机设备，适合敏感资料与断网环境。', 'Translation text stays on your device; ideal for sensitive text or offline reading.'),
    tradeoff: t('首次需下载模型或安装 Ollama，依赖本机内存与算力。', 'Requires initial model download or Ollama runtime; depends on local hardware.'),
    examples: [t('内置本地模型 (Hy-MT2 等)', 'Built-in local models'), 'Ollama', t('浏览器内置翻译 (Chrome/Edge)', 'Built-in browser AI')],
  },
])

const activeTier = computed(
  () => providerTiers.value.find((item) => item.key === providerTier.value) ?? providerTiers.value[0]
)

/* 2. 隐私防护模式交互切换 */
const shieldMode = ref<'redact' | 'block'>('redact')

/* 3. 网站规则模式交互切换 */
const ruleScope = ref<'supplement' | 'restrict'>('supplement')
</script>

<template>
  <!-- 1. 翻译服务路由与按功能分配示意图 -->
  <div v-if="kind === 'provider-routing'" class="pr-wrap">
    <div class="pr-split">
      <div class="fr-dg-card fr-dg-card-soft">
        <div class="fr-dg-card-title">
          <span>{{ t('① 服务目录（填写连接）', '1. Provider directory (Credentials)') }}</span>
          <span class="fr-dg-chip fr-dg-chip-slate">{{ t('点击只编辑', 'Click to edit') }}</span>
        </div>
        <p class="fr-dg-card-desc">
          {{ t('在「翻译服务」中填写密钥、接口地址、模型并点击「检查连接」。浏览目录本身不会改变当前默认服务。', 'Enter keys, endpoints, and models in Translation Providers and test connections. Editing a provider does not switch your active default.') }}
        </p>
        <div class="pr-mini-list">
          <span>• {{ t('免费翻译池 / 组合翻译回退', 'Free pool / Combo fallback') }}</span>
          <span>• {{ t('多 Key 自动轮换与冷却', 'Multi-key rotation & cooldown') }}</span>
          <span>• {{ t('服务级 / 模型级请求限速', 'Per-provider & per-model rate limits') }}</span>
        </div>
      </div>

      <div class="fr-dg-arrow" aria-hidden="true">→</div>

      <div class="fr-dg-card fr-dg-card-rose">
        <div class="fr-dg-card-title">
          <span>{{ t('② 按功能分配服务', '2. Assign per feature') }}</span>
          <span class="fr-dg-chip fr-dg-chip-rose">{{ t('独立或跟随默认', 'Custom or follow default') }}</span>
        </div>
        <div class="pr-routes">
          <div><b>{{ t('网页全文 / 悬浮', 'Page & Hover') }}</b><span>{{ t('默认网页服务', 'Default provider') }}</span></div>
          <div><b>{{ t('划词翻译 / AI 讲解', 'Selection & AI') }}</b><span>{{ t('独立配置更灵活', 'Dedicated fast / AI') }}</span></div>
          <div><b>{{ t('文档 / 视频 / 图片', 'Docs / Video / Image') }}</b><span>{{ t('按场景分别指定', 'Assigned per media') }}</span></div>
          <div><b>{{ t('翻译中心', 'Translation Center') }}</b><span>{{ t('多服务并行对照', 'Side-by-side compare') }}</span></div>
        </div>
      </div>
    </div>

    <div class="pr-tier-box">
      <div class="fr-dg-tabs" role="group" :aria-label="t('对比四类翻译服务', 'Compare provider categories')">
        <button
          v-for="tier in providerTiers"
          :key="tier.key"
          type="button"
          class="fr-dg-tab"
          :aria-pressed="providerTier === tier.key"
          @click="providerTier = tier.key"
        >
          {{ tier.label }}
        </button>
      </div>
      <div class="fr-dg-grid-2">
        <div class="fr-dg-card fr-dg-card-teal">
          <div class="fr-dg-card-title">{{ t('优势与适用', 'Strengths') }}</div>
          <p class="fr-dg-card-desc">{{ activeTier.pros }}</p>
        </div>
        <div class="fr-dg-card fr-dg-card-amber">
          <div class="fr-dg-card-title">{{ t('注意事项', 'Considerations') }}</div>
          <p class="fr-dg-card-desc">{{ activeTier.tradeoff }}</p>
        </div>
      </div>
      <div class="pr-examples">
        <span class="pr-ex-label">{{ t('代表服务：', 'Examples:') }}</span>
        <span v-for="ex in activeTier.examples" :key="ex" class="fr-dg-chip fr-dg-chip-slate">{{ ex }}</span>
      </div>
    </div>
  </div>

  <!-- 2. 本地隐私防护脱敏与阻断示意图 -->
  <div v-else-if="kind === 'privacy-shield'" class="ps-wrap">
    <div class="fr-dg-tabs" role="group" :aria-label="t('切换隐私防护策略', 'Switch privacy protection mode')">
      <button type="button" class="fr-dg-tab" :aria-pressed="shieldMode === 'redact'" @click="shieldMode = 'redact'">
        {{ t('模式 A：本地脱敏 → 翻译 → 本地还原', 'Mode A: Redact locally → Translate → Restore') }}
      </button>
      <button type="button" class="fr-dg-tab" :aria-pressed="shieldMode === 'block'" @click="shieldMode = 'block'">
        {{ t('模式 B：发现敏感内容即阻止发送', 'Mode B: Block request when detected') }}
      </button>
    </div>

    <div class="ps-lanes">
      <div class="fr-dg-zone fr-dg-zone-local">
        <div class="fr-dg-zone-label">
          <span class="fr-dg-chip fr-dg-chip-teal">{{ t('本机浏览器边界（不离开设备）', 'Local browser boundary (on-device)') }}</span>
        </div>
        <div class="ps-sample">
          <small>{{ t('待译原文', 'Original text') }}</small>
          <p>
            {{ t('请联系 ', 'Contact ') }}<mark class="ps-hit">alice@acme.test</mark>{{ t('，并核对单号 ', ' and verify key ') }}<mark class="ps-hit">sk-demo-9821</mark>
          </p>
        </div>
        <div class="ps-rule-row">
          <span class="fr-dg-chip fr-dg-chip-slate">{{ t('内置规则：邮箱 / 电话 / 证件 / 银行卡 / 密钥 / IPv4', 'Rules: Email / Phone / ID / Card / Key / IPv4') }}</span>
          <span class="fr-dg-chip fr-dg-chip-slate">{{ t('自定义词：最多 128 条', 'Custom terms: up to 128') }}</span>
        </div>
        <div v-if="shieldMode === 'redact'" class="ps-sample ps-restore">
          <small>{{ t('收到译文后本机还原（校验标记完整）', 'Restored locally after placeholder check') }}</small>
          <p>
            {{ t('Contact ', '请联系 ') }}<mark class="ps-ok">alice@acme.test</mark>{{ t(' and verify key ', '，并核对单号 ') }}<mark class="ps-ok">sk-demo-9821</mark>
          </p>
        </div>
        <div v-else class="ps-sample ps-blocked">
          <small>{{ t('拦截结果', 'Blocked locally') }}</small>
          <p>{{ t('✓ 命中邮箱与密钥规则，本次请求已中止，原文未发送至云端。', '✓ Matched email & key rules. Request stopped — nothing left your device.') }}</p>
        </div>
      </div>

      <div class="ps-bridge">
        <template v-if="shieldMode === 'redact'">
          <div class="ps-arrow-box ps-out">
            <span>{{ t('发送脱敏文本 →', 'Send redacted →') }}</span>
            <code>{{ t('请联系 [FR_1]，并核对单号 [FR_2]', 'Contact [FR_1] and verify key [FR_2]') }}</code>
          </div>
          <div class="ps-arrow-box ps-in">
            <span>{{ t('← 返回带标记译文', '← Return with tokens') }}</span>
            <code>{{ t('Contact [FR_1] and verify key [FR_2]', '请联系 [FR_1]，并核对单号 [FR_2]') }}</code>
          </div>
        </template>
        <div v-else class="ps-stop-badge">
          <strong>✕</strong>
          <span>{{ t('请求已拦截', 'Blocked') }}</span>
        </div>
      </div>

      <div class="fr-dg-zone fr-dg-zone-cloud">
        <div class="fr-dg-zone-label">
          <span class="fr-dg-chip fr-dg-chip-rose">{{ t('所选云端翻译服务', 'Selected translation provider') }}</span>
        </div>
        <p v-if="shieldMode === 'redact'" class="fr-dg-card-desc">
          {{ t('云端服务只能看到本次请求的随机占位标记，不会接触真实邮箱或密钥。若返回标记损坏或缺失，FluentRead 会拒绝展示且绝不改发明文。', 'The provider only sees randomized placeholders, never real PII. If any token is missing or altered, FluentRead aborts instead of retrying plaintext.') }}
        </p>
        <p v-else class="fr-dg-card-desc">
          {{ t('云端服务完全不会收到此次请求。适用于对公司内部名称或隐私字段零容忍的场景。', 'Zero bytes sent to the cloud provider. Ideal when internal names or sensitive fields must never leave your browser.') }}
        </p>
        <div class="ps-cache-note">
          {{ t('提示：开启隐私防护后，新请求自动跳过本地持久翻译缓存。', 'Note: Persistent translation cache read/write is skipped while Privacy Shield is enabled.') }}
        </div>
      </div>
    </div>
  </div>

  <!-- 3. 网站规则优先级与作用域图解 -->
  <div v-else class="sr-wrap">
    <div class="sr-waterfall">
      <div class="fr-dg-card fr-dg-card-rose">
        <div class="fr-dg-card-title">
          <span>{{ t('① 禁用扩展（最高优先级）', '1. Disable extension (Highest)') }}</span>
          <span class="fr-dg-chip fr-dg-chip-rose">{{ t('立即生效', 'Overrides all') }}</span>
        </div>
        <p class="fr-dg-card-desc">{{ t('优先于「始终翻译」与全局自动翻译，恢复原文并停用当前主域名（含子域名）上的扩展功能。', 'Overrides Auto-translate and all rules across the domain and subdomains.') }}</p>
      </div>
      <div class="fr-dg-card fr-dg-card-blue">
        <div class="fr-dg-card-title">
          <span>{{ t('② 网站偏好（按主域名）', '2. Site preferences (Per domain)') }}</span>
          <span class="fr-dg-chip fr-dg-chip-blue">{{ t('始终翻译 / 仅译文 / 隐藏悬浮球', 'Auto / Trans-only / Hide ball') }}</span>
        </div>
        <p class="fr-dg-card-desc">{{ t('控制触发方式与显示模式，不需要编写任何 CSS 选择器；切换「仅显示译文」对已有译文即时生效。', 'Controls automatic triggers and display mode with no CSS needed; Translation-only switches instantly.') }}</p>
      </div>
      <div class="fr-dg-card fr-dg-card-teal">
        <div class="fr-dg-card-title">
          <span>{{ t('③ 正文适配规则（自定义 > 官方专站 > 通用正文）', '3. Content adaptation (Custom > Official > Generic)') }}</span>
          <span class="fr-dg-chip fr-dg-chip-teal">{{ t('精细控制区域', 'DOM-level control') }}</span>
        </div>
        <p class="fr-dg-card-desc">{{ t('同 ID 自定义规则完整覆盖内置专站规则；可在「生效预览」中输入完整网址验证命中顺序。', 'Custom rules with matching IDs override built-in rules; verify precedence in Applied Rules Preview.') }}</p>
      </div>
    </div>

    <div class="sr-scope-box">
      <div class="sr-scope-top">
        <strong>{{ t('正文适配两种模式对比', 'Two Content Adaptation Modes') }}</strong>
        <div class="fr-dg-tabs sr-tabs" role="group" :aria-label="t('切换正文适配模式', 'Switch content rule mode')">
          <button type="button" class="fr-dg-tab" :aria-pressed="ruleScope === 'supplement'" @click="ruleScope = 'supplement'">
            {{ t('补充识别 (Supplement)', 'Supplement mode') }}
          </button>
          <button type="button" class="fr-dg-tab" :aria-pressed="ruleScope === 'restrict'" @click="ruleScope = 'restrict'">
            {{ t('限定范围 (Restrict)', 'Restrict mode') }}
          </button>
        </div>
      </div>

      <div class="fr-dg-grid-3 sr-dom">
        <div class="sr-node" :class="ruleScope === 'supplement' ? 'sr-on' : 'sr-off'">
          <b>{{ t('通用识别到的正文', 'Generic body content') }}</b>
          <span>{{ ruleScope === 'supplement' ? t('✓ 保留翻译', '✓ Translated') : t('— 跳过未声明区域', '— Skipped unless listed') }}</span>
        </div>
        <div class="sr-node sr-on">
          <b>{{ t('规则声明的 content 区域', 'Declared content selectors') }}</b>
          <span>{{ t('✓ 必定翻译', '✓ Always translated') }}</span>
        </div>
        <div class="sr-node sr-protect">
          <b>{{ t('protect / exclude 区域', 'Protected / excluded areas') }}</b>
          <span>{{ t('✕ 保持原文（代码/作者/标签）', '✕ Kept original (code/author/tags)') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pr-split {
  display: grid;
  grid-template-columns: 1fr auto 1.15fr;
  gap: 10px;
  align-items: stretch;
  margin-bottom: 16px;
}
.pr-mini-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--fr-ink, #26232c);
}
.pr-routes {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}
.pr-routes > div {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 6px;
  background: #ffffff;
  border: 1px solid #f1d4de;
  font-size: 11.5px;
}
.pr-routes span {
  color: var(--fr-muted, #6b6872);
}
.pr-tier-box {
  border-top: 1px solid var(--fr-line, #e7e7eb);
  padding-top: 14px;
}
.pr-examples {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}
.pr-ex-label {
  font-size: 11.5px;
  color: var(--fr-muted, #6b6872);
  font-weight: 600;
}

.ps-lanes {
  display: grid;
  grid-template-columns: 1.25fr 0.9fr 1fr;
  gap: 12px;
  align-items: stretch;
}
.ps-sample {
  border: 1px solid var(--fr-line, #e7e7eb);
  border-radius: 8px;
  padding: 9px 11px;
  background: #ffffff;
  font-size: 12px;
}
.ps-sample small {
  display: block;
  font-size: 10.5px;
  color: var(--fr-muted, #6b6872);
  margin-bottom: 3px;
}
.ps-hit {
  background: #fce4ec;
  color: #a61c48;
  padding: 1px 4px;
  border-radius: 4px;
  font-weight: 600;
}
.ps-ok {
  background: #e6f6f2;
  color: #1f665c;
  padding: 1px 4px;
  border-radius: 4px;
  font-weight: 600;
}
.ps-rule-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0;
}
.ps-restore {
  border-color: #b7dfd7;
}
.ps-blocked {
  border-color: #efcbd7;
  background: #fff9fb;
  color: #a61c48;
  font-weight: 600;
}
.ps-bridge {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 10px;
}
.ps-arrow-box {
  border-radius: 8px;
  padding: 9px 10px;
  font-size: 11.5px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ps-out {
  background: #fff4f7;
  border: 1px solid #f0cad6;
  color: #a61c48;
}
.ps-in {
  background: #eef8f6;
  border: 1px solid #c5e5de;
  color: #1f665c;
}
.ps-arrow-box code {
  font-size: 11px;
  background: rgba(255, 255, 255, 0.85);
  padding: 3px 5px;
  border-radius: 4px;
  word-break: break-word;
}
.ps-stop-badge {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 16px;
  border-radius: 10px;
  border: 1.5px dashed #d6688a;
  background: #fff5f8;
  color: #a61c48;
  font-weight: 700;
}
.ps-stop-badge strong {
  font-size: 20px;
  line-height: 1;
}
.ps-cache-note {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 7px;
  background: #ffffff;
  border: 1px solid #efcbd7;
  font-size: 11.5px;
  color: var(--fr-muted, #6b6872);
}

.sr-waterfall {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}
.sr-scope-box {
  border: 1px solid var(--fr-line, #e7e7eb);
  border-radius: 10px;
  padding: 13px;
  background: #faf9fb;
}
.sr-scope-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.sr-tabs {
  margin-bottom: 0;
}
.sr-node {
  border-radius: 8px;
  padding: 10px 12px;
  border: 1px solid var(--fr-line, #e7e7eb);
  background: #ffffff;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
}
.sr-on {
  border-color: #b7dfd7;
  background: #f5fbf9;
}
.sr-on span {
  color: #1f665c;
  font-weight: 600;
}
.sr-off {
  opacity: 0.72;
}
.sr-off span {
  color: var(--fr-muted, #6b6872);
}
.sr-protect {
  border-color: #f0dbb4;
  background: #fffbf4;
}
.sr-protect span {
  color: #8a5b12;
  font-weight: 600;
}

@container (max-width: 700px) {
  .pr-split,
  .ps-lanes {
    grid-template-columns: minmax(0, 1fr);
  }
  .pr-split .fr-dg-arrow {
    transform: rotate(90deg);
    height: 18px;
  }
}
</style>
