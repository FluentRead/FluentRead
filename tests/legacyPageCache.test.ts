import { describe, expect, it, vi } from 'vitest';
import {
  clearLegacyPageTranslationCache,
  type LegacyPageStorage,
} from '@/src/services/translation/legacyPageCache';

function createStorage(entries: Record<string, string>): LegacyPageStorage & { snapshot: () => Record<string, string> } {
  const values = new Map(Object.entries(entries));
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    removeItem(key) { values.delete(key); },
    snapshot() { return Object.fromEntries(values); },
  };
}

describe('legacy page cache migration', () => {
  it('removes only FluentRead page-cache records and its timestamp marker', () => {
    const storage = createStorage({
      hostPreference: 'keep-me',
      flcache_service_model_text: '旧译文',
      flcache_reverse_translation: '旧原文',
      flLastSessionTimestamp: '1234',
    });

    expect(clearLegacyPageTranslationCache(storage)).toBe(2);
    expect(storage.snapshot()).toEqual({hostPreference: 'keep-me'});
  });

  it('does not call broad clear and fails closed when page storage is unavailable', () => {
    const broken = {
      get length() { throw new DOMException('blocked'); },
      key: vi.fn(),
      getItem: vi.fn(),
      removeItem: vi.fn(),
    } as unknown as LegacyPageStorage;

    expect(clearLegacyPageTranslationCache(broken)).toBe(0);
    expect(broken.removeItem).not.toHaveBeenCalled();
  });

  it('removes a standalone timestamp but leaves unrelated and sparse keys untouched', () => {
    const values = new Map([['hostPreference', 'keep-me'], ['flLastSessionTimestamp', '1234']]);
    const storage: LegacyPageStorage & {snapshot: () => Record<string, string>} = {
      get length() { return 3; },
      key(index) { return index === 0 ? null : [...values.keys()][index - 1] ?? null; },
      getItem(key) { return values.get(key) ?? null; },
      removeItem(key) { values.delete(key); },
      snapshot() { return Object.fromEntries(values); },
    };

    expect(clearLegacyPageTranslationCache(storage)).toBe(0);
    expect(storage.snapshot()).toEqual({hostPreference: 'keep-me'});

    expect(clearLegacyPageTranslationCache(createStorage({hostPreference: 'still-here'}))).toBe(0);
  });

  it('uses page localStorage by default without touching host-owned records', () => {
    const originalWindow = globalThis.window;
    const storage = createStorage({
      hostPreference: 'keep-me',
      flcache_owned: 'delete-me',
    });
    Object.defineProperty(globalThis, 'window', {
      value: {localStorage: storage},
      configurable: true,
    });

    try {
      expect(clearLegacyPageTranslationCache()).toBe(1);
      expect(storage.snapshot()).toEqual({hostPreference: 'keep-me'});
    } finally {
      Object.defineProperty(globalThis, 'window', {value: originalWindow, configurable: true});
    }
  });
});

it('读取 localStorage 属性本身被拒绝也不会中断启动', () => {
  vi.stubGlobal('window', Object.defineProperty({}, 'localStorage', {
    get() { throw new DOMException('Access denied', 'SecurityError'); },
  }));
  try { expect(clearLegacyPageTranslationCache()).toBe(0); }
  finally { vi.unstubAllGlobals(); }
});
