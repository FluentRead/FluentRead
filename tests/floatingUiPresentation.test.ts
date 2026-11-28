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
    expect(cssRule(floatingBall, '.floating-ball-mascot')).toContain('filter: grayscale(var(--fr-ball-collapsed-grayscale))');
    expect(floatingBall).toContain('filter: none;');
    expect(floatingBall).toContain('prefers-reduced-motion: reduce');
    expect(floatingBall).toContain('outline: 2px solid var(--fr-accent)');
    expect(floatingBall).toContain('.floating-ball-manga .translation-indicator.is-counter');
    expect(floatingBall).toContain('mangaProgressSummary');
    expect(floatingBall).toContain('mangaActionLabel');
    expect(floatingBall).toContain("t('已翻译')");
    expect(floatingBall).toContain("t('已预译')");
    expect(floatingBall).toContain("t('翻译完成')");
    expect(floatingBall).toContain("if (mangaCompleted.value > 0) return 'translated';");

    const mangaEntry = source('src/features/image-translation/ui/manga-entry.css');
    const launcherRule = cssRule(mangaEntry, '.fr-manga-launcher');
    expect(launcherRule).toContain('grayscale(');
    expect(Number(launcherRule.match(/opacity:\s*([0-9.]+)/u)?.[1])).toBeLessThanOrEqual(0.36);
    expect(cssRule(mangaEntry, '.fr-manga-launcher.is-touch,.fr-manga-launcher.is-expanded,.fr-manga-launcher:focus-visible')).toContain('filter: none');
    expect(cssRule(mangaEntry, '.fr-manga-dock')).toContain('z-index: 2147483645');
    expect(cssRule(mangaEntry, '.fr-manga-peek-launcher')).toContain('touch-action: none');
    expect(mangaEntry).toContain('.fr-manga-reading-line-label > span:first-child:not(.fr-manga-reading-badge)');
    expect(mangaEntry).toMatch(/\.fr-manga-reading,\s*\.fr-manga-entry,\s*\.fr-manga-dock\s*\{/);

    const imageControlsCss = source('src/features/image-translation/ui/image-controls.css');
    expect(imageControlsCss).toContain('.fr-image-feedback[data-theme=dark][data-phase=error] .fr-image-actions > button {color:#171b24;}');
    expect(imageControlsCss).toContain('.fr-image-feedback:not([data-theme=light])[data-phase=error] .fr-image-actions > button {color:#171b24;}');
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
