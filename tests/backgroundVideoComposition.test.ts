import {expect, it, vi} from 'vitest';
const ports = vi.hoisted(() => ({subtitle: vi.fn(), semantic: vi.fn()}));
vi.mock('@/src/features/video-subtitle/background/runtime', () => ({createVideoSubtitleBackgroundRuntime: ports.subtitle}));
vi.mock('@/src/features/video-subtitle/background/semanticRuntime', () => ({createVideoSemanticRuntime: ports.semantic}));
import {createBackgroundVideoRuntime} from '@/src/app/background/videoRuntime';

it('assembles video factories lazily once while preserving handler order and identity', () => {
    expect(ports.subtitle).not.toHaveBeenCalled();
    expect(ports.semantic).not.toHaveBeenCalled();
    const subtitle = {type: 'subtitle'}, semantic = {type: 'semantic'}, cancel = {type: 'cancel'};
    ports.subtitle.mockReturnValue([subtitle]);
    ports.semantic.mockReturnValue([semantic, cancel]);
    const handlers = createBackgroundVideoRuntime();
    expect(ports.subtitle).toHaveBeenCalledOnce();
    expect(ports.semantic).toHaveBeenCalledOnce();
    expect(handlers).toHaveLength(3);
    expect(handlers[0]).toBe(subtitle);
    expect(handlers[1]).toBe(semantic);
    expect(handlers[2]).toBe(cancel);
});
