import {describe, expect, it, vi} from 'vitest';
import {createJapaneseRomanizer, formatJapaneseReadings, type JapaneseReadingToken} from '@/src/features/video-subtitle/reading/japanese';

function token(surface: string, reading?: string, pos = '名詞', detail = ''): JapaneseReadingToken {
    return {surface_form: surface, pronunciation: reading, pos, pos_detail_1: detail};
}

type TokenizerCallback = (error: Error | null, tokenizer: {tokenize(text: string): JapaneseReadingToken[]}) => void;

describe('Japanese video reading annotation', () => {
    it('uses pronunciation for particles and long vowels and joins verb auxiliaries', () => {
        expect(formatJapaneseReadings([
            token('私', 'ワタシ'), token('は', 'ワ', '助詞'), token('学校', 'ガッコー'), token('へ', 'エ', '助詞'),
            token('行き', 'イキ', '動詞'), token('ます', 'マス', '助動詞'), token('。', undefined, '記号'),
        ])).toBe('watashi wa gakkō e ikimasu.');
        expect(formatJapaneseReadings([token('本', 'ホン'), token('を', 'ヲ', '助詞'), token('読む', 'ヨム', '動詞')])).toBe('hon o yomu');
    });

    it('keeps sokuon across morphological boundaries, including contracted kana', () => {
        expect(formatJapaneseReadings([token('座っ', 'スワッ', '動詞'), token('て', 'テ', '助詞', '接続助詞'), token('ください', 'クダサイ', '動詞')])).toBe('suwatte kudasai');
        expect(formatJapaneseReadings([token('買っ', 'カッ', '動詞'), token('ちゃっ', 'チャッ', '動詞'), token('た', 'タ', '助動詞')])).toBe('katchatta');
        expect(formatJapaneseReadings([token('買っ', 'カッ', '動詞'), token('。', undefined, '記号')])).toBe('kaっ.');
    });

    it('joins conjunctions, suffixes and volitional long vowels', () => {
        expect(formatJapaneseReadings([token('会い', 'アイ', '動詞'), token('ましょ', 'マショ', '助動詞'), token('う', 'ウ', '助動詞')])).toBe('aimashō');
        expect(formatJapaneseReadings([token('行こ', 'イコ', '動詞'), token('う', 'ウ', '助動詞')])).toBe('ikō');
        expect(formatJapaneseReadings([token('食べ', 'タベ', '動詞'), token('て', 'テ', '助詞', '接続助詞')])).toBe('tabete');
        expect(formatJapaneseReadings([token('三', 'サン'), token('人', 'ニン', '名詞', '接尾')])).toBe('sannin');
    });

    it('covers bounded counter exceptions without changing longer numbers or ambiguous dates', () => {
        for (const [tokens, expected] of [
            [[token('一', 'イチ'), token('人', 'ニン')], 'hitori'],
            [[token('2'), token('人', 'ニン')], 'futari'],
            [[token('二', 'ニ'), token('十', 'ジュー'), token('歳', 'サイ')], 'hatachi'],
            [[token('20'), token('日', 'ニチ')], 'hatsuka'],
        ] as const) expect(formatJapaneseReadings(tokens)).toBe(expected);
        expect(formatJapaneseReadings([token('十', 'ジュー'), token('一', 'イチ'), token('人', 'ニン')])).not.toContain('hitori');
        expect(formatJapaneseReadings([token('一', 'イチ'), token('日', 'ニチ')])).not.toContain('tsuitachi');
        expect(formatJapaneseReadings([token('四月', 'シガツ'), token('一', 'イチ'), token('日', 'ニチ')])).toBe('shigatsu tsuitachi');
        expect(formatJapaneseReadings([token('何', 'ナニ'), token('です', 'デス', '助動詞')])).toBe('nan desu');
        expect(formatJapaneseReadings([token('何', 'ナニ'), token('を', 'ヲ', '助詞')])).toBe('nani o');
    });

    it('preserves a whole uncertain Han run and transliterates unknown katakana', () => {
        expect(formatJapaneseReadings([token('小鳥', 'コトリ'), token('遊'), token('さん', 'サン')])).toBe('小鳥遊 san');
        expect(formatJapaneseReadings([token('卡'), token('皮', 'ガワ'), token('巴', 'トモエ'), token('拉')])).toBe('卡皮巴拉');
        expect(formatJapaneseReadings([token('フルーエントリード')])).toBe('furūentorīdo');
    });

    it('checks separate Han runs across particles and punctuation while keeping suffix grouping', () => {
        expect(formatJapaneseReadings([
            token('東京', 'トーキョー'), token('大学', 'ダイガク'), token('で', 'デ', '助詞'),
            token('日本', 'ニホン'), token('語', 'ゴ', '名詞', '接尾'), token('を', 'ヲ', '助詞'),
            token('学ぶ', 'マナブ', '動詞'), token('。', undefined, '記号'), token('学校', 'ガッコー'),
        ])).toBe('tōkyō daigaku de nihongo o manabu. gakkō');
    });

    it('resumes checking after unknown runs and counter skips without partially guessing uncertain Han', () => {
        expect(formatJapaneseReadings([
            token('一', 'イチ'), token('人', 'ニン'), token('暮らし', 'グラシ', '名詞', '接尾'), token('と', 'ト', '助詞'),
            token('小鳥', 'コトリ'), token('遊'), token('さん', 'サン'), token('は', 'ワ', '助詞'),
            token('二', 'ニ'), token('人', 'ニン'), token('家族', 'カゾク'), token('。', undefined, '記号'),
        ])).toBe('hitorigurashi to 小鳥遊 san wa futari kazoku.');
        expect(formatJapaneseReadings([
            token('二', 'ニ'), token('人', 'ニン'), token('小鳥', 'コトリ'), token('遊'),
        ])).toBe('二人小鳥遊');
    });

    it('bounds input-property reads linearly for known Han runs up to the subtitle input limit', () => {
        for (const length of [64, 256, 1024, 3000]) {
            let reads = 0;
            const tokens: JapaneseReadingToken[] = Array.from({length}, () => ({
                get surface_form() {reads++; return '学';},
                get pronunciation() {reads++; return 'ガク';},
                get reading() {reads++; return undefined;},
                get pos() {reads++; return '名詞';},
                get pos_detail_1() {reads++; return '';},
            }));
            expect(formatJapaneseReadings(tokens)).toBe(Array.from({length}, () => 'gaku').join(' '));
            // 给每词元留出宽裕读取预算，检测重复遍历输入，不依赖机器速度或内部扫描次数。
            expect(reads).toBeLessThanOrEqual(length * 20);
        }
    });

    it('preserves mixed Latin text, whitespace and safe text characters without creating markup', () => {
        expect(formatJapaneseReadings([token('YouTube'), token('で', 'デ', '助詞'), token('AI'), token('を', 'ヲ', '助詞'), token('学ぶ', 'マナブ', '動詞')])).toBe('YouTube de AI o manabu');
        expect(formatJapaneseReadings([token('「', undefined, '記号'), token('東京', 'トーキョー'), token('」', undefined, '記号'), token(' ', undefined, '記号'), token('&'), token(' '), token('test')])).toBe('"tōkyō" & test');
        expect(formatJapaneseReadings([])).toBe('');
        expect(formatJapaneseReadings([token('😀'), token(' '), token('OK')])).toBe('😀 OK');
    });

    it('keeps incomplete counters and an isolated question word without inventing following tokens', () => {
        expect(formatJapaneseReadings([{surface_form:'かな',reading:'カナ'}])).toBe('kana');
        expect(formatJapaneseReadings([token('1')])).toBe('1');
        expect(formatJapaneseReadings([token('何','ナニ')])).toBe('nani');
    });

    it('shares one lazy initialization across concurrent calls and normalizes halfwidth kana', async () => {
        const tokenize = vi.fn(() => [token('パーティー', 'パーティー')]);
        let finish!: (error: Error | null, tokenizer: {tokenize: typeof tokenize}) => void;
        const build = vi.fn(() => ({build: (callback: TokenizerCallback) => {finish = callback;}}));
        const romanize = createJapaneseRomanizer(build);
        const first = romanize('ﾊﾟｰﾃｨｰ', 'https://extension.test/dict/');
        const second = romanize('パーティー', 'https://extension.test/dict');
        expect(build).toHaveBeenCalledTimes(1);
        expect(build).toHaveBeenCalledWith({dicPath: 'https://extension.test/dict'});
        finish(null, {tokenize});
        expect(await first).toBe('pātī');
        expect(await second).toBe('pātī');
        expect(tokenize).toHaveBeenCalledWith('パーティー');
    });

    it('releases a shared failed initialization for every waiter and permits a fresh dictionary build', async () => {
        let finish!: TokenizerCallback;
        const build=vi.fn(()=>({build:(callback:TokenizerCallback)=>{finish=callback;}}));
        const romanize=createJapaneseRomanizer(build);
        const first=expect(romanize('猫','/dict')).rejects.toThrow('shared dictionary failure');
        const second=expect(romanize('犬','/dict')).rejects.toThrow('shared dictionary failure');
        expect(build).toHaveBeenCalledOnce();finish(new Error('shared dictionary failure'),{tokenize:()=>[]});
        await Promise.all([first,second]);
        const retry=romanize('猫','/dict');expect(build).toHaveBeenCalledTimes(2);
        finish(null,{tokenize:()=>[token('猫','ネコ')]});await expect(retry).resolves.toBe('neko');
    });

    it('retries after an initialization failure and rejects switching a live dictionary', async () => {
        let attempt = 0;
        const build = vi.fn(() => ({build: (callback: TokenizerCallback) => {
            if (++attempt === 1) callback(new Error('dictionary unavailable'), {tokenize: () => []});
            else callback(null, {tokenize: () => [token('猫', 'ネコ')]});
        }}));
        const romanize = createJapaneseRomanizer(build);
        await expect(romanize('猫', '/dict')).rejects.toThrow('unavailable');
        await expect(romanize('猫', '/dict')).resolves.toBe('neko');
        await expect(romanize('猫', '/other')).rejects.toThrow('create a new Worker');
        expect(build).toHaveBeenCalledTimes(2);
    });

    it('avoids dictionaries for Latin-only text and bounds pathological input', async () => {
        const build = vi.fn();
        const romanize = createJapaneseRomanizer(build);
        await expect(romanize('AI 123', '')).resolves.toBe('AI 123');
        await expect(romanize('猫', ' ')).rejects.toThrow('URL is required');
        await expect(romanize('猫'.repeat(4097), '/dict')).rejects.toThrow('4096');
        expect(build).not.toHaveBeenCalled();
    });

    it('reports a broken tokenizer adapter as an initialization failure', async () => {
        const romanize = createJapaneseRomanizer(() => ({build: callback => callback(null)}));
        await expect(romanize('猫', '/dict')).rejects.toThrow('did not initialize');
    });
});
