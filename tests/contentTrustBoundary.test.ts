import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('host-page trust boundary', () => {
  it('does not expose page-dispatchable configuration or full-page controls', () => {
    const content = [
      source('entrypoints/content.ts'),
      source('src/app/content/runtime.ts'),
      source('src/app/content/hotkeyRuntime.ts'),
      source('src/app/content/messageRuntime.ts'),
      source('src/features/hover-translation/content/index.ts'),
      source('src/features/input-translation/content/index.ts'),
    ].join('\n');
    const floatingBall = source('src/features/floating-ball/ui/FloatingBall.vue');
    const hotkeyRuntime = source('src/app/content/hotkeyRuntime.ts');

    expect(existsSync(resolve(process.cwd(), 'entrypoints/utils/newApi.ts'))).toBe(false);
    expect(content).not.toContain('fluent:prefill');
    expect(content).not.toContain('fluentread-toggle-translation');
    expect(floatingBall).not.toContain('fluentread-toggle-translation');
    expect(hotkeyRuntime).not.toContain('toggleFloatingBallTranslation()');
    expect(hotkeyRuntime).toContain('if (isFullPageTranslationActive()) restoreOriginalContent();');
  });

  it('rejects synthetic input before network and screenshot side effects', () => {
    const content = [
      source('entrypoints/content.ts'),
      source('src/app/content/runtime.ts'),
      source('src/app/content/hotkeyRuntime.ts'),
      source('src/app/content/messageRuntime.ts'),
      source('src/features/hover-translation/content/index.ts'),
      source('src/features/input-translation/content/index.ts'),
    ].join('\n');
    const area = source('src/features/area-translation/ui/AreaTranslator.vue');
    const selection = source('src/features/selection-translation/ui/SelectionTranslator.vue');
    const video = [
      source('src/features/video-subtitle/content/runtime.ts'),
      source('src/features/video-subtitle/content/runtimeMenuControls.ts'),
    ].join('\n');

    expect(content.match(/if \(!event\.isTrusted\) return;/g)?.length).toBeGreaterThanOrEqual(10);
    for (const handler of ['handleKeydown', 'handlePointerdown', 'handlePointermove', 'handlePointerup', 'handlePointercancel']) {
      expect(area).toMatch(new RegExp(`function ${handler}\\(event: \\w+\\): void \\{\\s*if \\(!event\\.isTrusted\\) return;`));
    }
    expect(selection).toContain('TRUSTED_SELECTION_INTERACTION_GRACE_MS');
    expect(video.match(/if \(!event\.isTrusted\) return;/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('keeps privileged controls and translated bitmaps out of page-visible shadow roots', () => {
    expect(source('src/features/floating-ball/content/runtime.ts')).toContain("mode: 'closed'");
    expect(source('src/features/selection-translation/content/runtime.ts')).toContain("mode: 'closed'");
    expect(
      source('src/features/input-translation/content/index.ts')
      + '\n'
      + source('src/features/input-translation/content/tooltipUi.ts'),
    ).toContain("mode: 'closed'");
    expect(source('src/features/area-translation/content/runtime.ts')).toContain("mode: 'closed'");
    expect(source('src/features/image-translation/content/runtime.ts')).toContain("attachShadow({ mode: 'closed' })");
  });

  it('keeps the section picker behind trusted input and a closed shadow root', () => {
    const picker = [
      source('src/features/section-translation/content/picker.ts'),
      source('src/features/section-translation/content/pickerOverlay.ts'),
    ].join('\n');
    const entry = source('src/features/section-translation/content/index.ts');

    // 网页脚本不能伪造点击或按键替用户选择区域并发起翻译，也不能读取选择浮层。
    expect(picker).toContain("attachShadow({mode: 'closed'})");
    expect(picker.match(/if \(!event\.isTrusted\) return;/g)?.length).toBeGreaterThanOrEqual(9);
    // 同一信任守卫可以同时拒绝旧挂载实例；只能用 OR 收紧，不能用 AND 绕过不可信输入。
    expect(entry.match(/if \(!event\.isTrusted(?: \|\| activeStarter !== start)?\) return;/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(`${picker}\n${entry}`).not.toContain('CustomEvent');
  });

  it('keeps selection UI wheel handling out of the host document', () => {
    const selection = source('src/features/selection-translation/ui/SelectionTranslator.vue');

    // 卡片边缘要阻止滚动串入正文；只有 UI 内的非 passive 监听能执行 preventDefault。
    expect(selection).toContain('@wheel.stop="handleUiWheel"');
    expect(selection).not.toContain('@wheel.stop.passive="handleUiWheel"');
    expect(selection).toContain('if (event.ctrlKey) return;');
    expect(selection).toContain('if (event.cancelable) event.preventDefault();');
    expect(selection).not.toContain("document.addEventListener('wheel'");
    expect(selection).not.toContain("document.removeEventListener('wheel'");
  });
});
