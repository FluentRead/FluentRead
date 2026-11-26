<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { TinyColor } from '@ctrl/tinycolor'

withDefaults(defineProps<{ contrast?: boolean }>(), { contrast: false })
const groups = [
  { title: '品牌与操作', tokens: ['--brand', '--fr-color-brand-action', '--brand-strong', '--brand-soft'] },
  { title: '中性画布、表面与文字', tokens: ['--fr-color-canvas', '--surface', '--surface-soft', '--fr-color-surface-hover', '--ink', '--muted', '--line', '--fr-color-line-strong'] },
  { title: '状态反馈', tokens: ['--fr-success', '--fr-success-soft', '--fr-warning', '--fr-warning-soft', '--fr-danger', '--fr-danger-soft', '--fr-info', '--fr-info-soft'] },
]
const pairs = ['--ink', '--muted', '--brand-strong', '--fr-success', '--fr-warning', '--fr-danger', '--fr-info']
const values = ref<Record<string, string>>({})
let observer: MutationObserver | undefined
function refresh() {
  const style = getComputedStyle(document.documentElement)
  values.value = Object.fromEntries(groups.flatMap((group) => group.tokens).map((token) => [token, style.getPropertyValue(token).trim()]))
}
function ratio(token: string, bgToken: '--surface' | '--surface-soft' = '--surface') {
  const foreground = new TinyColor(values.value[token])
  const background = new TinyColor(values.value[bgToken])
  if (!foreground.isValid || !background.isValid) return null
  const [high, low] = [foreground.getLuminance(), background.getLuminance()].sort((a, b) => b - a)
  return (high + .05) / (low + .05)
}
onMounted(() => {
  refresh()
  observer = new MutationObserver(refresh)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-interface-skin'] })
})
onBeforeUnmount(() => observer?.disconnect())
</script>
<template>
  <div class="fr-story-stack">
    <p class="fr-story-note">色值直接读取当前主题的 CSS 变量。工具栏切换皮肤与明暗主题后，色板与 WCAG 2.2 对比度实时同步更新。</p>
    <template v-if="!contrast">
      <section v-for="group in groups" :key="group.title">
        <h2>{{ group.title }}</h2>
        <div class="fr-story-grid">
          <article v-for="token in group.tokens" :key="token" class="fr-story-tile">
            <div class="fr-color-swatch" :style="{ background: `var(${token})` }" aria-hidden="true" />
            <code>{{ token }}</code><small>{{ values[token] }}</small>
          </article>
        </div>
      </section>
      <p class="fr-story-note">权威定义位于 src/ui/styles/tokens.css（包含默认浅色与深色语义变量）；各皮肤在 src/ui/styles/interface-skins/ 中覆写对应变量。新组件严禁散落硬编码十六进制色值。</p>
    </template>
    <template v-else>
      <h2>文字在表面上的 WCAG 2.2 对比度</h2>
      <p>按照 <a href="https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html" target="_blank" rel="noopener noreferrer">WCAG 2.2 文字对比度</a>公式实时校验普通文字 AA（≥4.5:1）在主表面（<code>--surface</code>）与次级表面（<code>--surface-soft</code>）上的表现。</p>
      <table>
        <thead><tr><th>文字变量</th><th>示例</th><th>对 --surface</th><th>对 --surface-soft</th><th>AA 结论</th></tr></thead>
        <tbody><tr v-for="token in pairs" :key="token">
          <td><code>{{ token }}</code></td>
          <td :style="{ color: `var(${token})`, background: 'var(--surface)' }">流畅阅读 Aa</td>
          <td style="font-variant-numeric: tabular-nums">{{ ratio(token, '--surface')?.toFixed(2) ?? '—' }}:1</td>
          <td style="font-variant-numeric: tabular-nums">{{ ratio(token, '--surface-soft')?.toFixed(2) ?? '—' }}:1</td>
          <td>{{ ratio(token, '--surface') === null ? '无法计算' : (ratio(token, '--surface')! >= 4.5 && (ratio(token, '--surface-soft') ?? 0) >= 4.5) ? '双表面达标' : ratio(token, '--surface')! >= 4.5 ? '主表面达标' : '低于参考值' }}</td>
        </tr></tbody>
      </table>
      <p class="fr-story-note">主操作按钮文字（#ffffff）配 --fr-color-brand-action（浅色 #d62d5e = 4.69:1，深色 #d93464 = 4.54:1）同样满足 WCAG AA。</p>
    </template>
  </div>
</template>
<style scoped>
.fr-color-swatch { height: 56px; margin-bottom: 12px; border: 1px solid var(--line); border-radius: var(--fr-radius-sm, 8px); }
</style>
