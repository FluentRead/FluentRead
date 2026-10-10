/**
 * @file src/features/information-highlight/offscreen/scorer.ts
 * 文件职责：以可注入因果模型端口执行有界分块评分并明确管理每段的张量所有权。
 * 主要内容：模型标识、BOS 起点、全词表意外度、跨块 KV 缓存、准确 UTF-16 映射及取消释放；不截断输入，无上文的首个 token 取其余 token 的中位数。
 * 模块边界：不下载、不创建 Worker、不访问 DOM；模型持久会话由 Worker 持有，每段缓存只属于一次请求。
 */
import {alignQwenByteTokens, floatLogits, scoreCausalChunk, scoredTokenSpans} from '@/src/core/information-highlight/scoring';
import {INFORMATION_HIGHLIGHT_CHUNK_TOKENS, INFORMATION_HIGHLIGHT_MAX_CHARACTERS, INFORMATION_HIGHLIGHT_MAX_TOKENS, type InformationHighlightResult} from '../protocol';
export interface ScoringTensor {dims: readonly number[]; type: string; data: ArrayLike<number>; dispose(): void}
export type ScoringPast = Record<string, ScoringTensor>;
export interface CausalScoringEngine {
    name?: string;
    tokenize(text: string): {ids: number[]; pieces: string[]; addedTokens: ReadonlyMap<string, string>};
    bosId: number;
    forward(ids: number[], attentionLength: number, past: ScoringPast | null): Promise<Record<string, ScoringTensor>>;
    yield(): Promise<void>;
}
function active(signal: AbortSignal): void {if (signal.aborted) throw new DOMException('信息高亮已取消', 'AbortError');}
function dispose(values: Record<string, ScoringTensor>): void {new Set(Object.values(values)).forEach(tensor => tensor.dispose());}

/** 只随暖驻 Worker 存活的 LRU；精确原文作键，模型固定，postMessage 会复制结果，不保存到磁盘。 */
export function createSurprisalResultCache() {
    const entries = new Map<string, InformationHighlightResult>(); let characters = 0;
    return {
        get(text: string): InformationHighlightResult | undefined {
            const result = entries.get(text);
            if (result) {entries.delete(text); entries.set(text, result);}
            return result;
        },
        put(text: string, result: InformationHighlightResult): void {
            if (!entries.delete(text)) characters += text.length;
            entries.set(text, result);
            while (entries.size > 256 || characters > 400_000) {
                const oldest = entries.keys().next().value!;
                characters -= oldest.length; entries.delete(oldest);
            }
        },
    };
}

export async function scoreLocalSurprisal(engine: CausalScoringEngine, text: string, signal: AbortSignal): Promise<InformationHighlightResult> {
    active(signal);
    if (!text || text.length > INFORMATION_HIGHLIGHT_MAX_CHARACTERS) throw new Error('INFORMATION_HIGHLIGHT_TEXT_LIMIT');
    const encoded = engine.tokenize(text);
    if (!encoded.ids.length || encoded.ids.length > INFORMATION_HIGHLIGHT_MAX_TOKENS) throw new Error('INFORMATION_HIGHLIGHT_TOKEN_LIMIT');
    if (!Number.isInteger(engine.bosId) || engine.bosId < 0) throw new Error('INFORMATION_HIGHLIGHT_BOS');
    const offsets = alignQwenByteTokens(text, encoded.pieces, encoded.addedTokens);
    // Qwen tokenizer 不自动插入 BOS；config 的 151643 endoftext 明确作为文档起点，空 span 不参与绘制。
    const ids = [engine.bosId, ...encoded.ids], scores: number[] = [];
    let past: ScoringPast | null = null;
    try {
        // 最后 token 若独占新块，其行没有下一评分目标；跳过空收益块，其余块保持原 batch 形状与数值。
        for (let start = 0; start < encoded.ids.length; start += INFORMATION_HIGHLIGHT_CHUNK_TOKENS) {
            active(signal);
            const end = Math.min(start + INFORMATION_HIGHLIGHT_CHUNK_TOKENS, ids.length);
            const outputs = await engine.forward(ids.slice(start, end), end, past);
            let next: ScoringPast | null = null;
            try {
                active(signal);
                const logits = outputs.logits;
                if (!logits || logits.dims.length !== 3 || logits.dims[0] !== 1 || logits.dims[1] !== end - start) throw new Error('INFORMATION_HIGHLIGHT_BAD_LOGITS');
                scores.push(...scoreCausalChunk(floatLogits(logits.type, logits.data), logits.dims[2], ids, start, end));
                next = Object.fromEntries(Object.entries(outputs).filter(([name]) => name.startsWith('present.')).map(([name, value]) => [name.replace('present.', 'past_key_values.'), value]));
                if (!Object.keys(next).length) throw new Error('INFORMATION_HIGHLIGHT_NO_CACHE');
                if (past) dispose(past);
                past = next;
            } finally {
                const retained = new Set(Object.values(next || {}));
                dispose(Object.fromEntries(Object.entries(outputs).filter(([, value]) => !retained.has(value))));
            }
            await engine.yield();
        }
        active(signal);
        // 首个 token 只有 BOS 作前文，得到的是与正文无关的词表先验（固定模型在此近乎均匀，约 17 bits），
        // 会让每段开头恒为最深色；改用其余 token 的中位数作中性值，单 token 文本保持原值。
        if (scores.length > 1) {const rest = scores.slice(1).sort((a, b) => a - b); scores[0] = rest[rest.length >> 1];}
        return {spans: scoredTokenSpans(offsets, scores), engine: engine.name ?? 'Qwen2.5 0.5B · local WebGPU · q4f16'};
    } finally {if (past) dispose(past);}
}
