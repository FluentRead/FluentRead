<template>
  <div class="fr-story-stack">
    <div>
      <small>FLUENTREAD · DESIGN SYSTEM</small>
      <h1>流畅阅读设计体系与组件规范</h1>
      <p>以 <code>PRODUCT.md</code>、<code>DESIGN.md</code> 与 <code>src/ui/styles/tokens.css</code> 为单一事实源，集中校验视觉规范、真实 Vue 组件、微交互物理与亮暗皮肤适配。</p>
    </div>
    <div class="fr-story-grid">
      <article class="fr-story-tile">
        <h2>Foundations</h2>
        <p>WCAG 2.2 AA 色彩与对比度、7 级排版阶梯、5 级同心圆角与 4px 栅格、Emil 动效物理曲线。</p>
      </article>
      <article class="fr-story-tile">
        <h2>UI Components</h2>
        <p>下拉选择、分段控制、功能总开关、折叠卡片、下载进度、品牌图标与表单控件，支持 Controls 实时交互。</p>
      </article>
      <article class="fr-story-tile">
        <h2>Examples</h2>
        <p>Popup 320px 主控面板与设置中心组合示例，可直接切换浅色/深色、13 套皮肤、中英文与窄屏视口。</p>
      </article>
    </div>
    <p>工具栏可切换浅色 / 深色、内置皮肤、组件语言和预览尺寸。所有示例均不连接翻译服务，也不读写扩展配置。</p>
    <p><a href="https://read.thinkstu.com/guide/design-system" target="_blank" rel="noopener noreferrer">阅读设计系统介绍与开发指南 →</a></p>
    <small>样式来自 src/ui/styles/tokens.css 与 settings-page.css；组件来自 src/ui/components 与 src/features/settings/ui/components。</small>
  </div>
</template>
