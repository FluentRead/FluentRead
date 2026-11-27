<script setup lang="ts">
const radii = [
  { token: '--fr-radius-xs', value: '6px', usage: '徽标、kbd、分组折叠项' },
  { token: '--fr-radius-sm', value: '8px', usage: '按钮、输入框、下拉框、导航项' },
  { token: '--fr-radius-md', value: '10px', usage: '快捷功能卡、次级面板、消息提示' },
  { token: '--fr-radius-lg', value: '12px', usage: '主设置卡片、Popup 主卡、浮层菜单、弹窗' },
  { token: '--fr-radius-full', value: '9999px', usage: '开关轨道、圆形图标、胶囊标签' },
]
const spaces = [
  { token: '--fr-space-1', value: '4px' },
  { token: '--fr-space-2', value: '8px' },
  { token: '--fr-space-3', value: '12px' },
  { token: '--fr-space-4', value: '16px' },
  { token: '--fr-space-5', value: '20px' },
  { token: '--fr-space-6', value: '24px' },
  { token: '--fr-space-8', value: '32px' },
]
</script>
<template>
  <div class="fr-story-stack">
    <section>
      <h2>同心圆角阶梯（5 级收敛）</h2>
      <p class="fr-story-note">内层控件圆角始终小于等于外层容器圆角减去内边距，消除零散圆角。默认皮肤主卡片使用极克制轻阴影提升透气感，传统色皮肤保持纯色平涂。</p>
      <div class="fr-story-grid">
        <article v-for="item in radii" :key="item.token" class="fr-story-tile" :style="{ borderRadius: `var(${item.token})` }">
          <h3>{{ item.value }}</h3>
          <code>{{ item.token }}</code>
          <small>{{ item.usage }}</small>
        </article>
      </div>
    </section>

    <section>
      <h2>层级与阴影（Elevation）</h2>
      <div class="fr-story-grid">
        <article class="fr-story-tile" style="border-color: var(--fr-card-border); border-radius: var(--fr-card-radius); box-shadow: var(--fr-card-shadow)">
          <h3>Level 1 · 静态卡片</h3>
          <code>--fr-card-radius · --fr-card-shadow</code>
          <small>SettingsGroup / SettingsDisclosure（平涂 + 1px 细边框）</small>
        </article>
        <article class="fr-story-tile" style="border-radius: var(--fr-menu-radius); box-shadow: var(--fr-shadow-md)">
          <h3>Level 2 · 悬浮菜单</h3>
          <code>--fr-menu-radius · --fr-shadow-md</code>
          <small>UiSelect / 服务选择器 / Popover</small>
        </article>
        <article class="fr-story-tile" style="border-radius: var(--fr-menu-radius); box-shadow: var(--fr-shadow-lg)">
          <h3>Level 3 · 模态弹窗</h3>
          <code>--fr-shadow-lg</code>
          <small>ElDialog / Popup Drawer / 确认框</small>
        </article>
      </div>
    </section>

    <section>
      <h2>4px 空间栅格（Spacing Scale）</h2>
      <div class="fr-space-list">
        <div v-for="item in spaces" :key="item.token" class="fr-space-row">
          <code>{{ item.token }}</code>
          <span class="fr-space-bar" :style="{ width: `var(${item.token})` }" />
          <small>{{ item.value }}</small>
        </div>
      </div>
    </section>
  </div>
</template>
<style scoped>
.fr-space-list { display: grid; gap: 10px; padding: 16px; border: 1px solid var(--line); border-radius: var(--fr-radius-lg, 12px); background: var(--surface); }
.fr-space-row { display: grid; grid-template-columns: 140px auto 48px; align-items: center; gap: 12px; }
.fr-space-bar { display: block; height: 12px; border-radius: 3px; background: var(--brand-strong); }
.fr-space-row small { text-align: end; font-variant-numeric: tabular-nums; }
</style>
