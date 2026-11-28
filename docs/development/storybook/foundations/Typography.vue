<script setup lang="ts">
import { interfaceFontOptions } from '@/src/core/config/interfaceAppearance'
const scale = [
  { token: '--fr-text-2xl', size: '24px', weight: 700, title: '页面主标题（关于/文档）' },
  { token: '--fr-text-xl', size: '18px', weight: 600, title: '服务详情 / 抽屉标题' },
  { token: '--fr-text-lg', size: '15px', weight: 600, title: '分组标题 / 弹窗标题' },
  { token: '--fr-text-md', size: '14px', weight: 600, title: '控件值 / Popup 品牌名 / 阅读正文' },
  { token: '--fr-text-base', size: '13px', weight: 500, title: '设置项标签 / 侧栏导航 / 按钮' },
  { token: '--fr-text-sm', size: '12px', weight: 400, title: '辅助说明 / 表单帮助 / 快捷卡标题' },
  { token: '--fr-text-xs', size: '11px', weight: 500, title: '最小底线：徽标 / 快捷键 / 计数器（禁止 <11px）' },
]
</script>
<template>
  <div class="fr-story-stack">
    <section>
      <h2>7 级排版阶梯（Typography Scale）</h2>
      <p class="fr-story-note">使用标准字重（400 / 500 / 600 / 700）与 ≥11px 可读底线，保障中英混排清晰度；计数与进度统一使用 <code>tabular-nums</code>。</p>
      <div class="fr-type-stack">
        <div v-for="item in scale" :key="item.token" class="fr-story-tile">
          <div class="fr-type-meta">
            <code>{{ item.token }}</code>
            <small>{{ item.size }} · weight {{ item.weight }} · {{ item.title }}</small>
          </div>
          <p :style="{ fontSize: `var(${item.token})`, fontWeight: item.weight, marginBottom: 0 }">
            让语言更近，让世界更大。 Closer languages. A bigger world. 0123456789
          </p>
        </div>
      </div>
    </section>

    <section>
      <h2>等宽与等宽数字（Monospace &amp; Tabular Nums）</h2>
      <div class="fr-story-tile">
        <code>--fr-font-mono</code>
        <p style="font-family: var(--fr-font-mono); font-size: var(--fr-text-sm); font-variant-numeric: tabular-nums; margin: 8px 0 0;">
          ⌥+T · 12.8% · 1,024 / 2,048 · https://api.openai.com/v1
        </p>
      </div>
    </section>

    <section>
      <h2>字体方案</h2>
      <p class="fr-story-note">元数据来自扩展字体注册表。此页不下载字体；未安装的字体会按系统回退栈显示。</p>
      <div v-for="font in interfaceFontOptions" :key="font.value" class="fr-story-tile">
        <code>{{ font.value }}</code><small>{{ font.fontFamily }}</small>
        <p :style="{ fontFamily: font.fontFamily, marginBottom: 0 }">阅读连接更大的世界。 Reading connects us.</p>
      </div>
    </section>
  </div>
</template>
<style scoped>
.fr-type-stack { display: grid; gap: 10px; }
.fr-type-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin-bottom: 6px; }
</style>
