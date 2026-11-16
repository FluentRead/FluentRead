/**
 * @file tests/youtubeNativeCaptionVisibility.test.ts
 * 文件职责：验证 YouTube 原生字幕隐藏状态的独立播放器所有权。
 * 主要内容：覆盖重复同步、播放器切换、恢复宿主字幕与销毁幂等性。
 * 模块边界：使用最小 classList 替身，不挂载播放器、启动浏览器或触碰翻译服务。
 */
import {describe, expect, it, vi} from 'vitest';
import {createYoutubeNativeCaptionVisibility, VIDEO_NATIVE_CAPTION_HIDDEN_CLASS} from '@/src/features/video-subtitle/content/youtubeNativeCaptionVisibility';

function playerFixture() {
  const classes = new Set<string>();
  const classList = {
    add: vi.fn((name: string) => classes.add(name)),
    remove: vi.fn((name: string) => classes.delete(name)),
    contains: (name: string) => classes.has(name),
  };
  return {player: {classList} as unknown as HTMLElement, classList};
}

describe('YouTube 原生字幕隐藏状态', () => {
  it('重复同步保持稳定，切换播放器先恢复旧节点并在清理时交还原生字幕', () => {
    const visibility = createYoutubeNativeCaptionVisibility();
    const first = playerFixture();
    const second = playerFixture();

    visibility.sync(null);
    visibility.sync(first.player);
    visibility.sync(first.player);
    expect(first.classList.add).toHaveBeenCalledTimes(1);
    expect(first.classList.contains(VIDEO_NATIVE_CAPTION_HIDDEN_CLASS)).toBe(true);

    visibility.sync(second.player);
    expect(first.classList.remove).toHaveBeenCalledTimes(1);
    expect(first.classList.contains(VIDEO_NATIVE_CAPTION_HIDDEN_CLASS)).toBe(false);
    expect(second.classList.contains(VIDEO_NATIVE_CAPTION_HIDDEN_CLASS)).toBe(true);

    visibility.destroy();
    visibility.destroy();
    expect(second.classList.remove).toHaveBeenCalledTimes(1);
    expect(second.classList.contains(VIDEO_NATIVE_CAPTION_HIDDEN_CLASS)).toBe(false);
  });
});
