import {describe, expect, it} from 'vitest';
import {
    formatTokenCount,
    formatUsageRate,
} from '@/src/features/model-usage/model/tokenFormat';

describe('模型用量大数格式', () => {
    it('小于一万保留精确千分位，达到数量级后使用万、亿和万亿', () => {
        expect(formatTokenCount(9_999)).toEqual({compact: '9,999', exact: '9,999', isCompact: false});
        expect(formatTokenCount(10_000)).toEqual({compact: '1 万', exact: '10,000', isCompact: true});
        expect(formatTokenCount(34_600)).toEqual({compact: '3.46 万', exact: '34,600', isCompact: true});
        expect(formatTokenCount(1_234_567_890)).toEqual({
            compact: '12.35 亿',
            exact: '1,234,567,890',
            isCompact: true,
        });
        expect(formatTokenCount(1_000_000_000_000).compact).toBe('1 万亿');
    });

    it('四舍五入跨越单位时直接提升单位，并安全处理非法计数', () => {
        expect(formatTokenCount(99_999_999).compact).toBe('1 亿');
        expect(formatTokenCount(999_999_999_999).compact).toBe('1 万亿');
        expect(formatTokenCount(Number.MAX_SAFE_INTEGER)).toEqual({
            compact: '9,007.2 万亿',
            exact: '9,007,199,254,740,991',
            isCompact: true,
        });
        expect(formatTokenCount(-1)).toEqual({compact: '0', exact: '0', isCompact: false});
        expect(formatTokenCount(Number.NaN)).toEqual({compact: '0', exact: '0', isCompact: false});
    });

    it('按界面语言格式化单位与精确数值，不在英文或欧洲语言中残留中文单位', () => {
        expect(formatTokenCount(59_700, 'en-US')).toEqual({compact: '59.7K', exact: '59,700', isCompact: true});
        for (const locale of ['en-US', 'fr-FR', 'de-DE', 'es-ES', 'ja-JP', 'zh-TW']) {
            expect(formatTokenCount(1_234_567, locale).exact).toBe(new Intl.NumberFormat(locale).format(1_234_567));
            if (!locale.startsWith('zh') && locale !== 'ja-JP') expect(formatTokenCount(59_700, locale).compact).not.toMatch(/万|亿/);
        }
        expect(formatTokenCount(123, 'en-US').isCompact).toBe(false);
        expect(formatUsageRate(.1234, 'de-DE')).toBe(new Intl.NumberFormat('de-DE', {style: 'percent', maximumFractionDigits: 1}).format(.1234));
    });

    it('缓存率保留未知并最多显示一位百分比小数', () => {
        expect(formatUsageRate(null)).toBe('—');
        expect(formatUsageRate(0)).toBe('0%');
        expect(formatUsageRate(0.1234)).toBe('12.3%');
        expect(formatUsageRate(1)).toBe('100%');
    });
});
