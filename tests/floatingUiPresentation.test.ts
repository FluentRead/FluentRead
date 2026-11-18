import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function cssRule(file: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 同一完整选择器可拆分声明；不把较长选择器的后缀误当作独立规则。
  const matches = [...file.matchAll(new RegExp(`(?:^|\\n)\\s*${escapedSelector}\\s*\\{([^}]*)\\}`, 'gu'))];
  expect(matches.length, `缺少样式规则：${selector}`).toBeGreaterThan(0);
  return matches.map(match => match[1]).join('\n');
}

describe('低干扰悬浮 UI', () => {
  it('停靠与拖动共用变换，工具栏收起时隐藏，减弱动态效果时跳过过渡', () => {
    const floatingBall = source('src/features/floating-ball/ui/FloatingBall.vue');
    const root = cssRule(floatingBall, '.fr-floating-ball');
    expect(root).toContain('pointer-events: none');
    expect(root).toContain('transform: translate3d(var(--fr-drag-x, var(--fr-ball-x)), var(--fr-drag-y, var(--fr-ball-y)), 0)');
    expect(root).toContain('transition: transform');
    expect(cssRule(floatingBall, '.floating-ball-tools')).toContain('visibility: hidden');
    expect(cssRule(floatingBall, '.fr-floating-ball.viewport-sync')).toContain('transition: none');
    expect(floatingBall).toContain('prefers-reduced-motion: reduce');
    expect(floatingBall).toContain('outline: 2px solid var(--fr-accent)');
  });

  it('进度面板使用半透明背景，并由活动请求而非离屏候选决定显隐', () => {
    const panel = source('src/features/full-page-translation/ui/TranslationProgressPanel.vue');
    const panelRule = cssRule(panel, '.fr-translation-progress');
    const backgroundAlpha = Number(panelRule.match(/background:\s*rgba\([^;]+,\s*([0-9.]+)\)/u)?.[1]);

    expect(backgroundAlpha).toBeGreaterThanOrEqual(0.7);
    expect(backgroundAlpha).toBeLessThan(0.9);
    expect(panel).toContain('createProgressPanelVisibility(');
    expect(panel).not.toContain('progress.value.remaining > 0');
    expect(panel).toContain("class=\"fr-progress-compact-check\"");
    expect(panel).toContain("displayMode.value === 'compact'");
    expect(panel).toContain("t('fullPage.progress.compactActive')");
    expect(panel).toContain("t('fullPage.progress.modalWaiting')");
    expect(panel).toContain("fr-modal-waiting");
  });
});
