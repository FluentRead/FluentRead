<!-- 浏览器操作教程：以 Chrome 外壳定位安装、固定、翻译与本地模型准备的实际操作位置，仅播放示例而不访问商店或调用服务。 -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { withBase } from 'vitepress'
import { useDemoPlayback } from './useDemoPlayback'
import StepCallout from './StepCallout.vue'
import DemoSteps from './DemoSteps.vue'
import ExtensionMenuPreview from './ExtensionMenuPreview.vue'

const props = defineProps<{
  kind: 'install' | 'pin' | 'first-translation' | 'hover' | 'selection' | 'chrome-local'
  en?: boolean
}>()
const t = (zh: string, english: string) => (props.en ? english : zh)
const root = ref<HTMLElement | null>(null)
const instructions = computed(
  () =>
    ({
      install: [
        t('在 Chrome 应用商店打开流畅阅读的详情页', 'Open FluentRead in the Chrome Web Store'),
        t('点击“添加至 Chrome”', 'Click “Add to Chrome”'),
        t('在浏览器提示中点击“添加扩展程序”', 'Confirm with “Add extension”'),
        t(
          '安装完成后可以在扩展程序菜单中找到流畅阅读',
          'Find FluentRead in the extensions menu after installation'
        ),
      ],
      pin: [
        t('点击地址栏右侧的扩展程序图标', 'Click the extensions icon beside the address bar'),
        t('找到流畅阅读并点击右侧的固定图标', 'Find FluentRead and click its pin icon'),
        t('流畅阅读图标已显示在工具栏中', 'FluentRead now appears in the toolbar'),
        t('点击工具栏中的流畅阅读图标打开菜单', 'Click FluentRead in the toolbar to open its menu'),
      ],
      'first-translation': [
        t('打开外语文章并点击流畅阅读图标', 'Open an article and click FluentRead'),
        t('首次打开时，直接选择界面语言', 'On first use, choose your interface language'),
        t('选择界面语言并点击“确认”', 'Choose your language and click “Confirm”'),
        t('确认目标语言和翻译服务', 'Check your target language and translation provider'),
        t('点击“翻译”按钮', 'Click Translate'),
        t('译文会显示在每段原文下方', 'Read the translation below each original paragraph'),
        t(
          '需要回到原文时，打开菜单点击“还原”',
          'Open the menu and choose Restore to return to the original'
        ),
        t('网页已恢复为原文', 'The original webpage is restored'),
      ],
      hover: [
        t('点击扩展菜单中的“鼠标悬停翻译”卡片', 'Open the Hover translation card'),
        t('确认“默认悬浮快捷键”已开启', 'Check that the default hover shortcut is enabled'),
        t('将鼠标停在段落上并按下 Control', 'Move the pointer over a paragraph and press Control'),
        t('只有鼠标所指的段落会显示译文', 'Only the paragraph under the pointer is translated'),
        t('再次按下 Control 即可恢复这一段的原文', 'Press Control again to restore that paragraph'),
      ],
      selection: [
        t('点击扩展菜单中的“划词翻译”卡片', 'Open the Selection translation card'),
        t('在划词翻译设置中开启开关', 'Enable selection translation in its settings'),
        t('拖动鼠标选中需要翻译的文字', 'Drag to select the text you want to translate'),
        t('点击选中文字旁的流畅阅读图标', 'Click FluentRead beside the selected text'),
        t('在弹窗中查看译文或朗读结果', 'Read the translation or use the read-aloud controls'),
      ],
      'chrome-local': [
        t(
          '在通用设置中将默认网页翻译服务设为“Chrome内置AI翻译”',
          'Choose Chrome built-in AI as the default webpage provider'
        ),
        t(
          '点击“配置服务”并在连接设置中点击“检查连接”',
          'Open Configure provider, then click Check connection'
        ),
        t('首次使用需要联网下载相应的语言模型', 'Download the language model before first use'),
        t('等待当前语言组合准备完成', 'Wait until the selected language pair is ready'),
        t('回到网页后使用 Chrome 内置翻译', 'Return to the webpage and translate with Chrome'),
      ],
    }[props.kind])
)
const { step, playing, running, reduced, select, replay } = useDemoPlayback(
  root,
  instructions.value.length,
  true,
  4000
)
const title = computed(
  () =>
    ({
      install: t('安装浏览器扩展', 'Install the extension'),
      pin: t('将扩展图标固定到工具栏', 'Pin FluentRead to the toolbar'),
      'first-translation': t('翻译网页并恢复原文', 'Translate a webpage and restore the original'),
      hover: t('悬浮段落翻译', 'Hover translation'),
      selection: t('划词翻译', 'Selection translation'),
      'chrome-local': t('准备并使用 Chrome 本地翻译', 'Prepare and use Chrome translation'),
    }[props.kind])
)
const isLocalSettings = computed(() => props.kind === 'chrome-local' && step.value < 4)
const workflow = computed(
  () =>
    ({
      install: [
        t('打开应用商店', 'Open the store'),
        t('添加扩展', 'Add extension'),
        t('安装完成', 'Installed'),
      ],
      pin: [
        t('打开扩展菜单', 'Open extensions'),
        t('固定图标', 'Pin the icon'),
        t('打开流畅阅读', 'Open FluentRead'),
      ],
      'first-translation': [
        t('打开扩展菜单', 'Open FluentRead'),
        t('翻译网页', 'Translate'),
        t('恢复原文', 'Restore'),
      ],
      hover: [
        t('开启悬停翻译', 'Enable hover'),
        t('悬停并翻译', 'Hover & translate'),
        t('恢复原文', 'Restore'),
      ],
      selection: [
        t('开启划词翻译', 'Enable selection'),
        t('选中文字', 'Select text'),
        t('查看译文', 'Read translation'),
      ],
      'chrome-local': [
        t('选择本地翻译', 'Choose Chrome'),
        t('准备语言模型', 'Prepare models'),
        t('翻译网页', 'Translate'),
      ],
    }[props.kind])
)
const activeStage = computed(() => {
  if (props.kind === 'first-translation') return step.value < 4 ? 0 : step.value < 6 ? 1 : 2
  if (props.kind === 'chrome-local') return step.value === 0 ? 0 : step.value < 4 ? 1 : 2
  if (props.kind === 'selection') return step.value < 2 ? 0 : step.value === 2 ? 1 : 2
  if (props.kind === 'hover') return step.value < 2 ? 0 : step.value < 4 ? 1 : 2
  return step.value === 0 ? 0 : step.value < 3 ? 1 : 2
})
const stageStarts = computed(() => {
  if (props.kind === 'first-translation') return [0, 4, 6]
  if (props.kind === 'chrome-local') return [0, 1, 4]
  if (props.kind === 'selection') return [0, 2, 3]
  if (props.kind === 'hover') return [0, 2, 4]
  return [0, 1, 3]
})
const pinned = computed(() => props.kind !== 'install' && (props.kind !== 'pin' || step.value >= 2))
const menuVisible = computed(
  () =>
    (props.kind === 'pin' && step.value === 3) ||
    (props.kind === 'first-translation' && [3, 4].includes(step.value)) ||
    (['hover', 'selection'].includes(props.kind) && step.value < 2)
)
const translated = computed(
  () =>
    (props.kind === 'first-translation' && [5, 6].includes(step.value)) ||
    (props.kind === 'hover' && step.value === 3) ||
    (props.kind === 'chrome-local' && step.value === 4)
)
const original = computed(() =>
  t('Reading opens a window to the world.', '阅读为我们打开一扇了解世界的窗。')
)
const translation = computed(() =>
  t('阅读为我们打开一扇了解世界的窗。', 'Reading opens a window to the world.')
)
</script>

<template>
  <div
    ref="root"
    class="bg"
    :class="`bg-${kind}`"
    :data-visual="kind"
    :data-step="step"
    :data-playing="playing"
    :data-running="running"
  >
    <div class="bg-heading">
      <strong>{{ title }}</strong>
      <small>{{ t('以 Chrome 为例', 'Chrome example') }}</small>
    </div>
    <DemoSteps
      :labels="workflow"
      :active="activeStage"
      :label="t('操作流程', 'Workflow')"
      :playing="playing"
      :reduced="reduced"
      :en="en"
      @select="select($event, stageStarts)"
    />
    <div class="bg-instruction" :aria-live="playing ? 'off' : 'polite'">
      <span>{{ step + 1 }} / {{ instructions.length }}</span>
      {{ instructions[step] }}
    </div>
    <div class="bg-browser">
      <div class="bg-tabs" aria-hidden="true">
        <span class="bv-dots">
          <i></i>
          <i></i>
          <i></i>
        </span>
        <span>
          {{
            kind === 'install'
              ? 'Chrome Web Store'
              : isLocalSettings
              ? t('流畅阅读设置', 'FluentRead settings')
              : t('阅读的乐趣', 'The joy of reading')
          }}
          <i>×</i>
        </span>
        <b>+</b>
      </div>
      <div class="bg-toolbar">
        <span class="bg-navigation" aria-hidden="true">← &nbsp; → &nbsp; ↻</span>
        <span class="bg-address">
          <span aria-hidden="true">⌕</span>
          {{
            kind === 'install'
              ? 'chromewebstore.google.com'
              : isLocalSettings
              ? t('流畅阅读 · 设置', 'FluentRead · Settings')
              : 'example.com/article'
          }}
        </span>
        <span class="bg-tool" :class="{ 'bg-target': kind === 'pin' && step === 0 }">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M9 4v3H5v5H3a2 2 0 0 0 0 4h2v5h5v-2a2 2 0 0 1 4 0v2h5v-5h-2a2 2 0 0 1 0-4h2V7h-5V4a2.5 2.5 0 0 0-5 0Z"
            />
          </svg>
          <StepCallout
            v-if="kind === 'pin' && step === 0"
            :number="1"
            :text="t('点击扩展程序', 'Open extensions')"
          />
        </span>
        <span
          v-if="pinned"
          class="bg-tool"
          :class="{
            'bg-target':
              (kind === 'pin' && [2, 3].includes(step)) ||
              (kind === 'first-translation' && step === 0),
          }"
        >
          <img :src="withBase('/brand-icon.webp')" width="22" height="22" :alt="t('流畅阅读', 'FluentRead')" />
          <StepCallout
            v-if="kind === 'pin' && [2, 3].includes(step)"
            :number="step + 1"
            :text="
              step === 2
                ? t('图标已固定', 'Icon pinned')
                : t('点击图标打开菜单', 'Click to open the menu')
            "
          />
          <StepCallout
            v-if="kind === 'first-translation' && step === 0"
            :number="1"
            :text="t('点击流畅阅读图标', 'Click FluentRead')"
          />
        </span>
        <span aria-hidden="true">⋮</span>
      </div>

      <div class="bg-viewport">
        <template v-if="kind === 'install'">
          <div class="bg-store">
            <small>chrome web store</small>
            <div class="bg-store-product">
              <img :src="withBase('/brand-icon.webp')" width="56" height="56" alt="" />
              <div>
                <h3>{{ t('流畅阅读', 'FluentRead') }}</h3>
                <p>
                  {{ t('网页双语翻译扩展', 'Bilingual translation for your browser') }}
                </p>
              </div>
            </div>
            <span class="bg-store-button" :class="{ 'bg-target': step === 1 }">
              {{
                step === 3
                  ? t('已添加至 Chrome', 'Added to Chrome')
                  : t('添加至 Chrome', 'Add to Chrome')
              }}
              <StepCallout
                v-if="step === 1"
                :number="2"
                :text="t('点击添加至 Chrome', 'Click Add to Chrome')"
                align="start"
              />
            </span>
            <div class="bg-store-description">
              <b>{{ t('轻松阅读外语网页', 'Read across languages') }}</b>
              <p>
                {{
                  t(
                    '支持网页、划词、文档和图片翻译。',
                    'Translate webpages, selections, documents and images.'
                  )
                }}
              </p>
              <div class="bg-store-preview">
                <span>Reading opens a window to the world.</span>
                <span>阅读为我们打开一扇了解世界的窗。</span>
              </div>
            </div>
          </div>
          <div v-if="step === 2" class="bg-dialog">
            <strong>{{ t('要添加“流畅阅读”吗？', 'Add “FluentRead”?') }}</strong>
            <p>
              {{ t('请核对浏览器列出的扩展权限。', 'Review the permissions shown by Chrome.') }}
            </p>
            <div>
              <span>{{ t('取消', 'Cancel') }}</span>
              <span class="bg-target bg-action">
                {{ t('添加扩展程序', 'Add extension') }}
                <StepCallout :number="3" :text="t('确认安装扩展', 'Confirm installation')" />
              </span>
            </div>
          </div>
          <div v-if="step === 3" class="bg-install-success">
            ✓ {{ t('流畅阅读已安装', 'FluentRead is installed') }}
          </div>
        </template>
        <template v-else-if="isLocalSettings">
          <div class="bg-settings">
            <aside aria-hidden="true">
              <img :src="withBase('/brand-icon.webp')" width="28" height="28" alt="" />
              <b>{{ t('设置', 'Settings') }}</b>
              <span :class="{ active: step === 0 }">{{ t('通用设置', 'General') }}</span>
              <span :class="{ active: step > 0 }">{{ t('翻译服务', 'Providers') }}</span>
              <span>{{ t('界面风格', 'Appearance') }}</span>
            </aside>
            <div class="bg-settings-content">
              <h3>
                {{
                  step === 0
                    ? t('基础配置', 'Basic settings')
                    : t('Chrome内置AI翻译', 'Chrome built-in AI translation')
                }}
              </h3>
              <template v-if="step === 0">
                <p>
                  {{ t('为网页翻译选择服务', 'Choose a provider for webpage translation') }}
                </p>
                <div class="bg-setting-row">
                  <span>{{ t('默认网页翻译服务', 'Default webpage provider') }}</span>
                  <b>{{ t('Chrome内置AI翻译', 'Chrome built-in AI translation') }}⌄</b>
                </div>
                <div class="bg-provider-list">
                  <span>{{ t('免费翻译服务', 'Free translation') }}</span>
                  <span class="bg-target bg-provider-selected">
                    ✓ {{ t('Chrome内置AI翻译', 'Chrome built-in AI translation') }}
                    <StepCallout
                      :number="1"
                      :text="t('选择 Chrome 内置翻译', 'Choose Chrome translation')"
                    />
                  </span>
                </div>
              </template>
              <template v-else>
                <small class="bg-local-badge">
                  {{ t('在本机翻译 · 无需密钥', 'On-device translation · no API key') }}
                </small>
                <div class="bg-setting-row">
                  <span>{{ t('本次检查', 'Language pair') }}</span>
                  <b>{{ t('英语 → 简体中文', 'Chinese → English') }}</b>
                </div>
                <span class="bg-action bg-prepare" :class="{ 'bg-target': step === 1 }">
                  {{ step === 2 ? t('准备中…', 'Preparing…') : t('检查连接', 'Check connection') }}
                  <StepCallout
                    v-if="step === 1"
                    :number="2"
                    :text="t('点击检查连接', 'Check the connection')"
                    align="start"
                  />
                </span>
                <div v-if="step === 2" class="bg-download">
                  <span>
                    {{ t('正在准备当前语言组合…', 'Preparing the language pair…') }}
                  </span>
                  <i><b></b></i>
                </div>
                <p v-if="step === 3" class="bg-ready">
                  ✓ {{ t('本次语言对已就绪', 'The language pair is ready') }}
                </p>
                <p>
                  {{
                    t(
                      '首次准备需要联网。完成后回到网页翻译。',
                      'Connect to download the model, then return to your webpage.'
                    )
                  }}
                </p>
              </template>
            </div>
          </div>
        </template>
        <template v-else>
          <article class="bg-article">
            <small>EXAMPLE JOURNAL</small>
            <h3>{{ t('The joy of reading', '阅读的乐趣') }}</h3>
            <div class="bg-paragraph" :class="{ 'bg-hovered': kind === 'hover' && step > 1 }">
              <p>
                <mark :class="{ 'bg-selected': kind === 'selection' && step > 1 }">
                  {{ original }}
                  <StepCallout
                    v-if="kind === 'selection' && step === 2"
                    :number="3"
                    :text="t('拖动选中文字', 'Drag to select text')"
                  />
                </mark>
              </p>
              <p v-if="translated" class="bg-translation">{{ translation }}</p>
              <span v-if="kind === 'hover' && step > 1" class="bg-pointer">
                <StepCallout
                  :number="step + 1"
                  :text="
                    step === 2
                      ? t('悬停后按 Control', 'Hover and press Control')
                      : step === 3
                      ? t('查看这一段的译文', 'Read this translation')
                      : t('再按 Control 恢复', 'Press Control to restore')
                  "
                />
              </span>
              <span v-if="kind === 'selection' && step === 3" class="bg-selection-icon bg-target">
                <img :src="withBase('/brand-icon.webp')" width="24" height="24" :alt="t('流畅阅读', 'FluentRead')" />
                <StepCallout
                  :number="4"
                  :text="t('点击图标查看译文', 'Click to see the translation')"
                />
              </span>
            </div>
            <div class="bg-paragraph">
              <p>
                {{ t('A good book can take you somewhere new.', '一本好书能带你发现新的天地。') }}
              </p>
              <p v-if="translated && kind !== 'hover'" class="bg-translation">
                {{ t('一本好书能带你发现新的天地。', 'A good book can take you somewhere new.') }}
              </p>
            </div>
            <span v-if="kind === 'hover' && step > 1" class="bg-keypress">
              <kbd>Control</kbd>
              {{
                step === 2
                  ? t('按下快捷键', 'Press the key')
                  : step === 3
                  ? t('显示译文', 'Translation shown')
                  : t('再次按下以恢复原文', 'Press again to restore')
              }}
            </span>
            <span v-if="kind === 'chrome-local'" class="bg-local-badge">
              {{ t('由 Chrome 本地模型翻译', 'Translated by Chrome on your device') }}
            </span>
          </article>
          <div v-if="kind === 'pin' && step === 1" class="bg-extension-menu">
            <strong>{{ t('扩展程序', 'Extensions') }}</strong>
            <div>
              <img :src="withBase('/brand-icon.webp')" width="26" height="26" alt="" />
              <b>{{ t('流畅阅读', 'FluentRead') }}</b>
              <span class="bg-pin-icon bg-target">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m8 3 8 0-1 7 3 4v2H6v-2l3-4ZM12 16v6" />
                </svg>
                <StepCallout :number="2" :text="t('点击固定图标', 'Click the pin icon')" />
              </span>
            </div>
          </div>
          <ExtensionMenuPreview
            v-if="kind === 'first-translation' && [1, 2].includes(step)"
            :en="en"
            :mode="step === 1 ? 'welcome' : 'language'"
            :number="step + 1"
          />
          <ExtensionMenuPreview
            v-if="menuVisible"
            :en="en"
            :mode="
              ['hover', 'selection'].includes(kind) && step === 1
                ? kind === 'hover'
                  ? 'hover'
                  : 'selection'
                : 'main'
            "
            :target="
              kind === 'first-translation'
                ? step === 3
                  ? 'language'
                  : 'translate'
                : step === 1
                ? undefined
                : kind === 'hover'
                ? 'hover'
                : kind === 'selection'
                ? 'selection'
                : undefined
            "
            :number="step + 1"
          />
          <div v-if="kind === 'selection' && step === 4" class="bg-selection-result">
            <small>{{ t('原文', 'Original') }}</small>
            <p>{{ original }}</p>
            <small>{{ t('译文', 'Translation') }}</small>
            <p class="bg-selection-result-translation">{{ translation }}</p>
            <span>{{ t('朗读原文 · 朗读译文', 'Read original · Read translation') }}</span>
          </div>
        </template>
      </div>
    </div>
    <div class="bg-controls">
      <small>{{ t('自动演示 · 示例界面', 'Auto demo · example interface') }}</small>
      <div>
        <button
          v-if="!reduced"
          type="button"
          @click="playing = !playing"
          :aria-label="
            playing
              ? t('暂停自动演示', 'Pause automatic demo')
              : t('播放自动演示', 'Play automatic demo')
          "
        >
          {{ playing ? t('Ⅱ 暂停', 'Ⅱ Pause') : t('▷ 播放', '▷ Play') }}
        </button>
        <button type="button" @click="replay">
          {{ t('↻ 重播', '↻ Replay') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bg {
  container-type: inline-size;
  margin: 24px 0;
  border: 1px solid var(--fr-line);
  border-radius: 12px;
  overflow: hidden;
  background: white;
  color: var(--fr-ink);
  font-size: 12px;
  line-height: 1.6;
}
.bg-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--fr-line);
}
.bg-heading strong {
  font-size: 13px;
}
.bg-heading small {
  color: var(--fr-muted);
  font-size: 10px;
  white-space: nowrap;
}
.bg-instruction {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 60px;
  padding: 12px 20px;
  font-size: 13px;
}
.bg-instruction > span {
  flex: none;
  border-radius: 5px;
  background: #fff1f5;
  color: var(--vp-c-brand-1);
  padding: 2px 7px;
  font-size: 10px;
}
.bg-browser {
  margin: 0 18px 18px;
  border: 1px solid #dedde4;
  border-radius: 9px;
  overflow: hidden;
  box-shadow: 0 4px 12px #26232c08;
}
.bg-tabs {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 36px;
  padding: 0 12px;
  background: #ececf0;
  font-size: 10px;
}
.bg-tabs > span:nth-child(2) {
  display: flex;
  align-items: center;
  gap: 24px;
  align-self: end;
  padding: 7px 12px;
  border-radius: 7px 7px 0 0;
  background: #fafafa;
}
.bg-tabs i {
  font-style: normal;
}
.bg-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 42px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--fr-line);
  background: #fafafa;
  color: #77717e;
}
.bg-navigation {
  white-space: nowrap;
  font-size: 14px;
}
.bg-address {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  padding: 4px 10px;
  border-radius: 20px;
  background: #eeeef1;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bg-address > span {
  padding-right: 6px;
}
.bg-tool {
  display: grid;
  place-items: center;
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 5px;
}
.bg-tool svg,
.bg-pin-icon svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: #65616e;
  stroke-width: 1.6;
  stroke-linejoin: round;
}
.bg-viewport {
  position: relative;
  height: 380px;
  overflow: hidden;
  background: white;
}
.bg-first-translation .bg-viewport {
  height: 360px;
}
.bg-hover .bg-viewport,
.bg-selection .bg-viewport {
  height: 440px;
}
.bg-target {
  position: relative;
  z-index: 2;
  outline: 2px solid #b92252;
  outline-offset: 4px;
}
.bg-action :deep(.sc-end),
.bg-feature-switch :deep(.sc-end),
.bg-provider-selected :deep(.sc-end),
.bg-selected :deep(.sc-end) {
  right: 8px;
}
.bg .bg-store {
  padding: 22px 30px;
}
.bg-store > small {
  font-size: 12px;
  color: #66616d;
}
.bg-store-product {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 18px;
}
.bg h3 {
  margin: 0;
  padding: 0;
  border: 0;
  font-size: 20px;
  line-height: 1.3;
  letter-spacing: 0;
}
.bg p {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
}
.bg-store-product p {
  color: var(--fr-muted);
  font-size: 11px;
  margin-top: 4px;
}
.bg-store-button {
  display: inline-block;
  margin-top: 14px;
  padding: 8px 14px;
  border-radius: 20px;
  background: #1765cc;
  color: white;
  font-size: 11px;
}
.bg-store-description {
  margin-top: 62px;
}
.bg-store-description > b {
  font-size: 13px;
}
.bg-store-description > p {
  margin-top: 5px;
  font-size: 11px;
  color: var(--fr-muted);
}
.bg-store-preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
  padding: 12px 16px;
  border-left: 2px solid var(--vp-c-brand-1);
  background: #fcf6f8;
  font-size: 11px;
}
.bg-store-preview > span:last-child {
  color: var(--vp-c-brand-1);
}
.bg-dialog {
  position: absolute;
  top: 12px;
  right: 14px;
  width: min(300px, calc(100% - 28px));
  padding: 18px 18px 64px;
  border: 1px solid #dedde4;
  border-radius: 10px;
  background: white;
  box-shadow: 0 10px 40px #26232c20;
}
.bg-dialog p {
  margin-top: 8px;
  font-size: 11px;
  color: var(--fr-muted);
}
.bg-dialog > div {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 18px;
  margin-top: 22px;
}
.bg-action {
  display: block;
  padding: 9px 12px;
  border-radius: 6px;
  background: var(--vp-c-brand-1);
  color: white;
  text-align: center;
  font-size: 11px;
}
.bg-dialog .bg-action {
  background: #1765cc;
}
.bg-install-success {
  position: absolute;
  top: 10px;
  right: 14px;
  padding: 10px 16px;
  border: 1px solid #cce0d8;
  border-radius: 8px;
  background: #f0faf5;
  color: #39796c;
}
.bg .bg-article {
  padding: 28px 32px;
}
.bg-article > small {
  font-size: 8px;
  color: var(--fr-muted);
  letter-spacing: 1.5px;
}
.bg .bg-article h3 {
  margin: 8px 0 20px;
  font: 600 25px/1.3 Georgia, 'Noto Serif SC', serif;
}
.bg-paragraph {
  position: relative;
  margin-bottom: 18px;
  padding: 8px 0;
}
.bg-paragraph p {
  font-size: 13px;
}
.bg-paragraph mark {
  position: relative;
  padding: 2px 0;
  background: none;
  color: inherit;
}
.bg-paragraph mark.bg-selected {
  display: inline-block;
  background: #dbe6ff;
}
.bg-hover .bg-paragraph:first-of-type {
  margin-bottom: 60px;
}
.bg-selection .bg-paragraph:first-of-type {
  margin-bottom: 96px;
}
.bg-paragraph p.bg-translation {
  padding-left: 10px;
  border-left: 2px solid var(--vp-c-brand-1);
  margin-top: 8px;
  color: var(--vp-c-brand-1);
}
.bg-hovered {
  margin-inline: -10px;
  padding-inline: 10px;
  border-radius: 4px;
  outline: 1px dashed #b92252;
  background: #fff9fb;
}
.bg-pointer {
  position: absolute;
  right: 20px;
  bottom: 2px;
  width: 2px;
  height: 2px;
}
.bg-keypress {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 10px;
  color: var(--fr-muted);
}
.bg-keypress kbd {
  padding: 4px 9px;
  border: 1px solid #b92252;
  border-bottom-width: 3px;
  border-radius: 5px;
  background: #fff1f5;
  color: var(--vp-c-brand-1);
  font-size: 11px;
}
.bg-extension-menu {
  position: absolute;
  top: 0;
  right: 10px;
  width: 270px;
  max-width: calc(100% - 20px);
  padding: 16px;
  border: 1px solid #dedde4;
  border-radius: 0 0 8px 8px;
  background: white;
  box-shadow: 0 8px 32px #26232c1a;
}
.bg-extension-menu > div {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 18px;
  padding-bottom: 54px;
}
.bg-extension-menu b {
  flex: 1;
  font-size: 12px;
}
.bg-pin-icon {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 4px;
}
.bg-popup {
  position: absolute;
  top: 0;
  right: 10px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 252px;
  max-width: calc(100% - 20px);
  padding: 16px 16px 64px;
  border: 1px solid #dedde4;
  border-radius: 0 0 9px 9px;
  background: white;
  box-shadow: 0 8px 32px #26232c1a;
}
.bg-popup > strong {
  font-size: 14px;
}
.bg-popup-languages {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.bg-popup-languages span {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  font-size: 9px;
  color: var(--fr-muted);
}
.bg-popup-languages b {
  border: 1px solid var(--fr-line);
  border-radius: 5px;
  padding: 5px 6px;
  color: var(--fr-ink);
  font-size: 11px;
}
.bg-popup-languages i {
  font-style: normal;
}
.bg-popup-service {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 0;
  font-size: 10px;
}
.bg-popup-service b {
  font-size: 10px;
}
.bg-feature-switch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 9px;
  border-radius: 5px;
  background: #faf7f9;
}
.bg-feature-switch b {
  font-size: 11px;
}
.bg-switch-knob {
  position: relative;
  width: 28px;
  height: 16px;
  border-radius: 20px;
  background: var(--vp-c-brand-1);
}
.bg-switch-knob::before {
  content: '';
  position: absolute;
  top: 2px;
  right: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: white;
}
.bg-welcome {
  align-items: center;
  padding-block: 22px 64px;
}
.bg-language-choice {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid #ecc2cf;
  border-radius: 5px;
  background: #fff5f8;
  font-size: 11px;
}
.bg-welcome .bg-action {
  width: 100%;
}
.bg-selection-icon {
  position: absolute;
  bottom: -28px;
  left: 45%;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 4px;
  background: white;
  box-shadow: 0 2px 8px #26232c20;
}
.bg-selection-result {
  position: absolute;
  top: 138px;
  left: 15%;
  width: 70%;
  padding: 16px;
  border: 1px solid var(--fr-line);
  border-radius: 8px;
  background: white;
  box-shadow: 0 6px 24px #26232c15;
}
.bg-selection-result small {
  color: var(--fr-muted);
  font-size: 10px;
}
.bg-selection-result p {
  margin-block: 4px 8px;
}
.bg-selection-result p.bg-selection-result-translation {
  color: var(--vp-c-brand-1);
}
.bg-selection-result > span {
  font-size: 10px;
  color: var(--fr-muted);
}
.bg-settings {
  display: flex;
  height: 100%;
}
.bg-settings aside {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 16px;
  width: 110px;
  padding: 20px 12px;
  border-right: 1px solid var(--fr-line);
  background: #fafafa;
}
.bg-settings aside > span {
  font-size: 10px;
  color: var(--fr-muted);
}
.bg-settings aside > .active {
  color: var(--vp-c-brand-1);
  font-weight: 650;
}
.bg-settings-content {
  flex: 1;
  min-width: 0;
  padding: 22px 24px;
}
.bg .bg-settings-content h3 {
  font-size: 17px;
  margin-bottom: 12px;
}
.bg-settings-content p {
  margin-top: 12px;
  font-size: 11px;
  color: var(--fr-muted);
}
.bg-setting-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  margin-top: 14px;
  border-bottom: 1px solid var(--fr-line);
  font-size: 10px;
}
.bg-setting-row b {
  font-size: 10px;
}
.bg-provider-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: max-content;
  max-width: 100%;
  margin: 8px 0 0 auto;
  border: 1px solid var(--fr-line);
  border-radius: 6px;
  padding: 8px;
  font-size: 11px;
}
.bg-provider-list > span {
  padding: 5px 8px;
  border-radius: 3px;
}
.bg-provider-selected {
  color: var(--vp-c-brand-1);
  background: #fff1f5;
}
.bg-local-badge {
  display: inline-block;
  color: #39796c;
  font-size: 10px;
}
.bg-prepare {
  display: inline-block;
  margin-top: 18px;
}
.bg-prepare.bg-target {
  margin-bottom: 60px;
}
.bg-download {
  margin-top: 18px;
  font-size: 10px;
}
.bg-download > i {
  display: block;
  height: 5px;
  margin-top: 8px;
  border-radius: 8px;
  background: #eceaee;
  overflow: hidden;
}
.bg-download b {
  display: block;
  width: 62%;
  height: 100%;
  background: #b92252;
}
.bg .bg-ready {
  color: #39796c;
}
.bg-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 18px;
  border-top: 1px solid var(--fr-line);
}
.bg-controls small {
  color: var(--fr-muted);
  font-size: 10px;
}
.bg-controls > div {
  display: flex;
  gap: 10px;
}
.bg-controls button {
  color: var(--vp-c-brand-1);
  padding: 4px 2px;
  font-size: 11px;
}
.bg button:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 3px;
}
@container (max-width: 480px) {
  .bg-first-translation .bg-viewport {
    height: 340px;
  }
  .bg-viewport {
    height: 420px;
  }
  .bg-heading,
  .bg-instruction {
    padding-inline: 14px;
  }
  .bg-heading {
    align-items: start;
  }
  .bg-heading strong {
    font-size: 12px;
  }
  .bg-instruction {
    min-height: 72px;
    font-size: 12px;
  }
  .bg-browser {
    margin-inline: 10px;
  }
  .bg-toolbar {
    gap: 8px;
    padding-inline: 8px;
  }
  .bg-navigation {
    display: none;
  }
  .bg .bg-store,
  .bg .bg-article {
    padding: 22px 18px;
  }
  .bg-store-product img {
    width: 42px;
    height: 42px;
  }
  .bg h3 {
    font-size: 18px;
  }
  .bg .bg-article h3 {
    font-size: 23px;
  }
  .bg-paragraph p {
    font-size: 12px;
  }
  .bg-settings aside {
    width: 78px;
    padding-inline: 9px;
  }
  .bg-settings-content {
    padding: 20px 14px;
  }
  .bg .bg-settings-content h3 {
    font-size: 15px;
  }
  .bg-setting-row {
    flex-direction: column;
    align-items: start;
    gap: 6px;
  }
  .bg-selection-icon {
    left: 65%;
  }
  .bg-prepare :deep(.sc-start) {
    left: 0;
    max-width: 100%;
  }
  .bg-provider-list {
    font-size: 10px;
  }
  .bg-controls {
    padding-inline: 12px;
  }
  .bg-controls > div {
    gap: 7px;
  }
}
</style>
