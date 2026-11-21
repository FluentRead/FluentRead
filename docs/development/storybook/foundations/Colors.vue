<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { TinyColor } from '@ctrl/tinycolor'

withDefaults(defineProps<{ contrast?: boolean }>(), { contrast: false })
const groups = [
  { title: '品牌与操作', tokens: ['--brand', '--brand-strong', '--brand-soft'] },
  { title: '文字与表面', tokens: ['--ink', '--muted', '--line', '--surface', '--surface-soft'] },
  { title: '状态反馈', tokens: ['--fr-success', '--fr-success-soft', '--fr-warning', '--fr-warning-soft', '--fr-danger', '--fr-danger-soft', '--fr-info', '--fr-info-soft'] },
]
const pairs = ['--ink', '--muted', '--brand-strong', '--fr-success', '--fr-warning', '--fr-danger', '--fr-info']
const values = ref<Record<string, string>>({})
let observer: MutationObserver | undefined
function refresh() {
  const style = getComputedStyle(document.documentElement)
  values.value = Object.fromEntries(groups.flatMap((group) => group.tokens).map((token) => [token, style.getPropertyValue(token).trim()]))
}
function ratio(token: string) {
  const foreground = new TinyColor(values.value[token])
  const background = new TinyColor(values.value['--surface'])
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
    <p class="fr-story-note">色值来自当前主题的 CSS 变量。工具栏切换皮肤与明暗主题后，色板和数值同步更新。</p>
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
      <p class="fr-story-note">默认颜色定义在 src/ui/styles/tokens.css；深色值由设置页基础主题提供，皮肤在 interface-skins 中覆盖相应变量。新组件优先使用语义变量。</p>
    </template>
    <template v-else>
      <h2>文字在表面上的对比度</h2>
      <p>按照 <a href="https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html" target="_blank" rel="noopener noreferrer">WCAG 2.2 文字对比度</a>公式计算当前颜色组合。普通文字 AA 参考值为 4.5:1，大字为 3:1；这里只检查列出的纯色组合。</p>
      <table>
        <thead><tr><th>文字变量</th><th>示例</th><th>对比度</th><th>普通文字 AA</th></tr></thead>
        <tbody><tr v-for="token in pairs" :key="token">
          <td><code>{{ token }}</code></td>
          <td :style="{ color: `var(${token})`, background: 'var(--surface)' }">流畅阅读 Aa</td>
          <td>{{ ratio(token)?.toFixed(2) ?? '—' }}:1</td>
          <td>{{ ratio(token) === null ? '无法计算' : ratio(token)! >= 4.5 ? '达到参考值' : '低于参考值' }}</td>
        </tr></tbody>
      </table>
      <p class="fr-story-note">对比度只是可读性的一部分；仍需结合字号、字重、焦点、禁用状态与实际背景检查组件。</p>
    </template>
  </div>
</template>
<style scoped>
.fr-color-swatch { height: 64px; margin-bottom: 14px; border: 1px solid var(--line); border-radius: 8px; }
</style>
