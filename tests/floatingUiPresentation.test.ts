import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function cssRule(file: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = file.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, 'u'));
  expect(match, `缺少样式规则：${selector}`).not.toBeNull();
  return match?.[1] ?? '';
}

function numericDeclaration(rule: string, property: string): number {
  const match = rule.match(new RegExp(`${property}:\\s*([0-9.]+)`, 'u'));
  expect(match, `缺少样式属性：${property}`).not.toBeNull();
  return Number(match?.[1]);
}

/** 读取 CSS 变量声明的兜底数值，用于验证未配置时保持原有观感。 */
function variableFallback(rule: string, property: string, variable: string): number {
  const match = rule.match(new RegExp(`${property}:\\s*var\\(${variable},\\s*([0-9.]+)\\)`, 'u'));
  expect(match, `缺少 CSS 变量兜底：${property}/${variable}`).not.toBeNull();
  return Number(match?.[1]);
}

describe('低干扰悬浮 UI', () => {
  it('全文翻译切换不再自动展开菜单或弹出快捷键提示', () => {
    const floatingBall = source('src/features/floating-ball/ui/FloatingBall.vue');
    const toggleTranslation = floatingBall.match(/function toggleTranslation\([^)]*\) \{([\s\S]*?)\n\}/u)?.[1] ?? '';
    const handleDocumentKeydown = floatingBall.match(/function handleDocumentKeydown\([^)]*\) \{([\s\S]*?)\n\}/u)?.[1] ?? '';

    expect(toggleTranslation).toContain('props.onTranslationToggle(!isTranslating.value)');
    expect(toggleTranslation).not.toContain('isExpanded.value = true');
    expect(toggleTranslation).toContain('isExpanded.value = false');
    expect(toggleTranslation).toContain('event.detail > 0');
    expect(toggleTranslation).toContain('?.blur()');
    expect(toggleTranslation).not.toContain('isTranslating.value =');
    expect(floatingBall).not.toContain('showShortcutTooltip');
    expect(floatingBall).toContain('defineExpose({ toggleTranslation, setTranslationState })');
    expect(handleDocumentKeydown).toContain("querySelector<HTMLElement>(':focus')?.blur()");
    expect(handleDocumentKeydown).toContain('isExpanded.value = false');
  });

  it('收起态保持半透明，交互态恢复清晰，并把勾选标记留在可见侧', () => {
    const floatingBall = source('src/features/floating-ball/ui/FloatingBall.vue');
    const rightCollapsed = cssRule(
      floatingBall,
      '.fr-floating-ball:not(.floating-ball-expanded):not(.dragging)[data-position="right"] .floating-ball-main',
    );
    const leftCollapsed = cssRule(
      floatingBall,
      '.fr-floating-ball:not(.floating-ball-expanded):not(.dragging)[data-position="left"] .floating-ball-main',
    );
    const expanded = cssRule(
      floatingBall,
      '.fr-floating-ball.floating-ball-expanded .floating-ball-item',
    );

    const rightFallback = variableFallback(rightCollapsed, 'opacity', '--fr-ball-collapsed-opacity');
    expect(rightFallback).toBeGreaterThanOrEqual(0.4);
    expect(rightFallback).toBeLessThanOrEqual(0.6);
    expect(variableFallback(leftCollapsed, 'opacity', '--fr-ball-collapsed-opacity')).toBe(rightFallback);
    expect(numericDeclaration(expanded, 'opacity')).toBe(1);
    expect(numericDeclaration(cssRule(floatingBall, '.dragging .floating-ball-main'), 'opacity')).toBe(1);
    expect(cssRule(
      floatingBall,
      '.fr-floating-ball[data-position="right"] .floating-ball-main .check-mark',
    )).toContain('left: -1px');
    expect(cssRule(
      floatingBall,
      '.fr-floating-ball[data-position="left"] .floating-ball-main .check-mark',
    )).toContain('right: -1px');
  });

  it('中间 Logo 只有越过拖动阈值后才改变位置', () => {
    const floatingBall = source('src/features/floating-ball/ui/FloatingBall.vue');
    const startDrag = floatingBall.match(/function startDrag\([^)]*\) \{([\s\S]*?)\n\}/u)?.[1] ?? '';
    const handlePointerMove = floatingBall.match(/function handlePointerMove\([^)]*\) \{([\s\S]*?)\n\}/u)?.[1] ?? '';

    expect(startDrag).not.toContain('isExpanded.value = false');
    expect(startDrag).not.toContain('isDragging.value = true');
    expect(startDrag).not.toContain('positionStyle.value =');
    expect(handlePointerMove).toContain('<= DRAG_THRESHOLD) return');
    expect(handlePointerMove).toContain('currentDrag.moved = true');
    expect(handlePointerMove).toContain('isExpanded.value = false');
    expect(handlePointerMove).toContain('isDragging.value = true');
    expect(handlePointerMove).toContain('event.clientX - currentDrag.pointerOffsetX');
    expect(handlePointerMove).toContain('event.clientY - currentDrag.pointerOffsetY');
  });

  it('悬浮球按展示契约控制按钮显示方式、展开延迟与点击行为', () => {
    const floatingBall = source('src/features/floating-ball/ui/FloatingBall.vue');
    const expandBall = floatingBall.match(/function expandBall\([^)]*\) \{([\s\S]*?)\n\}/u)?.[1] ?? '';
    const runMainAction = floatingBall.match(/function runMainAction\([^)]*\) \{([\s\S]*?)\n\}/u)?.[1] ?? '';
    const finishPointerInteraction = floatingBall.match(/function finishPointerInteraction\([^)]*\) \{([\s\S]*?)\n\}/u)?.[1] ?? '';

    // 始终显示模式不再依赖悬停状态，隐藏模式连翻译按钮一起收走。
    expect(floatingBall).toContain("presentation.value.toolsDisplay === 'always'");
    expect(floatingBall).toContain("presentation.value.toolsDisplay !== 'hidden'");
    expect(floatingBall).toContain('showSettingsTool = computed(() => showTranslateTool.value && presentation.value.settingsEntryVisible)');
    // 悬停延迟只推迟展开；拖动中到期的计时器不得把菜单弹回来。
    expect(expandBall).toContain('isAlwaysExpanded.value) return');
    expect(expandBall).toContain('Math.max(0, presentation.value.hoverDelay)');
    expect(expandBall).toContain('if (!isDragging.value) isExpanded.value = true;');
    expect(floatingBall).toContain('clearExpandTimer();');
    expect(floatingBall).toContain('onBeforeUnmount');
    // 未越过拖动阈值才触发点击行为，'none' 保留纯拖动手柄。
    expect(finishPointerInteraction).toContain('runMainAction(event)');
    expect(runMainAction).toContain("action === 'translate'");
    expect(runMainAction).toContain("action === 'settings'");
    expect(runMainAction).toContain('props.onTranslationToggle(!isTranslating.value)');
  });

  it('悬浮球尺寸与收起不透明度来自配置变量，紧凑模式等比缩小', () => {
    const floatingBall = source('src/features/floating-ball/ui/FloatingBall.vue');
    const root = cssRule(floatingBall, '.fr-floating-ball');
    const compact = cssRule(floatingBall, '.fr-floating-ball.is-compact');
    const main = cssRule(floatingBall, '.floating-ball-main');
    const tool = cssRule(floatingBall, '.floating-ball-tool');

    expect(numericDeclaration(root, '--fr-ball-size')).toBe(48);
    expect(numericDeclaration(compact, '--fr-ball-size')).toBeLessThan(48);
    expect(numericDeclaration(compact, '--fr-ball-tool-size'))
      .toBeLessThan(numericDeclaration(root, '--fr-ball-tool-size'));
    expect(main).toContain('width: var(--fr-ball-size)');
    expect(main).toContain('height: var(--fr-ball-size)');
    expect(tool).toContain('width: var(--fr-ball-tool-size)');
    expect(floatingBall).toContain("'--fr-ball-collapsed-opacity': String(presentation.value.collapsedOpacity / 100)");
    expect(cssRule(floatingBall, '.floating-ball-item')).toContain('translateX(var(--fr-ball-size))');
  });

  it('进度面板使用半透明背景，并由活动请求而非离屏候选决定显隐', () => {
    const panel = source('src/features/full-page-translation/ui/TranslationProgressPanel.vue');
    const panelRule = cssRule(panel, '.fr-translation-progress');
    const backgroundAlpha = Number(panelRule.match(/background:\s*rgba\([^;]+,\s*([0-9.]+)\)/u)?.[1]);

    expect(backgroundAlpha).toBeGreaterThanOrEqual(0.7);
    expect(backgroundAlpha).toBeLessThan(0.9);
    expect(panel).toContain('hasActiveFullPageTranslationWork(progress.value)');
    expect(panel).not.toContain('progress.value.remaining > 0');
    expect(panel).toContain("class=\"fr-progress-compact-check\"");
    expect(panel).toContain('shouldShowCompactFullPageTranslationStatus(');
    expect(panel).toContain("t('fullPage.progress.compactActive')");
    expect(panel).toContain("t('fullPage.progress.modalWaiting')");
    expect(panel).toContain("fr-modal-waiting");
  });
});
