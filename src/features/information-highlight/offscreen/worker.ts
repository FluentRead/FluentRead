/**
 * @file src/features/information-highlight/offscreen/worker.ts
 * 文件职责：在静态模块 Worker 内加载已校验离线 Qwen 模型并执行可取消的因果评分。
 * 主要内容：Worker 首次评分绑定所选模型，固定 revision/q4f16/WebGPU 与模型各自的 KV 精度，结果缓存只属于该模型；包内 JSEP 资源、NFC tokenizer、串行推理和块间取消，任何评分都禁止下载。
 * 模块边界：不访问扩展存储或宿主 DOM；下载与 Worker 暖机看守由离屏运行时负责。
 */
import {AutoConfig, AutoModelForCausalLM, AutoTokenizer, env, Tensor} from '@huggingface/transformers';
import {getInformationHighlightModel, type InformationHighlightModelId} from '@/src/core/config/informationHighlightModel';
import {localWasmThreads, paceLocalInference, paceLocalInitialization} from '@/src/shared/onnx/resources';
import {configureOnnxWasmBackend} from '@/src/shared/onnx/wasmBinary';
import {getInformationHighlightArtifactStore} from './artifacts';
import {createSurprisalResultCache, scoreLocalSurprisal, type CausalScoringEngine, type ScoringPast, type ScoringTensor} from './scorer';
import type {InformationHighlightResult} from '../protocol';
export interface InformationHighlightWorkerRequest {requestId: number; type: 'score' | 'cancel'; text?: string; modelId?: InformationHighlightModelId}
export interface InformationHighlightWorkerResponse {requestId: number; success: boolean; initialized: boolean; stage?: 'initializing' | 'scoring'; result?: InformationHighlightResult; error?: string}

export function startInformationHighlightWorker(): void {
    let artifactStore = getInformationHighlightArtifactStore(), boundModel: InformationHighlightModelId | undefined;
    // 3.8.1 要求 local_files_only 与 allowLocalModels 同时开启，customCache 先于任何本地文件探测。
    env.allowLocalModels = true; env.allowRemoteModels = false; env.useBrowserCache = false; env.useFSCache = false;
    env.localModelPath = new URL('local-models/', self.location.href).href;
    env.remoteHost = 'https://huggingface.co/'; env.remotePathTemplate = '{model}/resolve/{revision}/';
    env.useCustomCache = true; env.customCache = {match: (request: string | Request) => artifactStore.match(request), put: async () => {throw new Error('INFORMATION_HIGHLIGHT_NOT_DOWNLOADED');}};
    const wasm = env.backends.onnx.wasm;
    if (wasm) {
        wasm.numThreads = localWasmThreads();
        configureOnnxWasmBackend(wasm, {mjs: new URL('fluent-read-ai/ort-wasm-simd-threaded.asyncify.mjs', self.location.href).href, wasm: new URL('fluent-read-ai/ort-wasm-simd-threaded.asyncify.wasm', self.location.href).href});
    }
    let engine: CausalScoringEngine | undefined, creating: Promise<CausalScoringEngine> | undefined;
    const controllers = new Map<number, AbortController>();
    const results = createSurprisalResultCache();
    let tail: Promise<void> = Promise.resolve();
    const getEngine = (modelId: InformationHighlightModelId): Promise<CausalScoringEngine> => {
        if (boundModel !== undefined && boundModel !== modelId) return Promise.reject(new Error('INFORMATION_HIGHLIGHT_INVALID_MODEL'));
        boundModel = modelId;
        return creating ??= paceLocalInitialization(async () => {
        const descriptor = getInformationHighlightModel(modelId);
        artifactStore = getInformationHighlightArtifactStore(modelId);
        const options = {revision: descriptor.revision, local_files_only: true};
        const config = await AutoConfig.from_pretrained(descriptor.repository, options);
        const tokenizer = await AutoTokenizer.from_pretrained(descriptor.repository, options);
        // 导出图的 KV 精度由各自固定清单明确指定，不能仅凭 q4f16 名称推断。
        config['transformers.js_config'] = {kv_cache_dtype: descriptor.kvCacheDtype};
        const model = await AutoModelForCausalLM.from_pretrained(descriptor.repository, {...options, config, device: 'webgpu', dtype: 'q4f16'});
        const addedTokens = new Map<string, string>();
        // added token 字面串不经过 ByteLevel 编码，必须按原字面 UTF-8 对齐。
        for (const token of tokenizer.added_tokens) addedTokens.set(token.content, token.content);
        engine = {
            name: `${descriptor.name} · local WebGPU · q4f16`,
            bosId: Number((config as unknown as {bos_token_id: number}).bos_token_id),
            tokenize(text) {
                const ids = tokenizer.encode(text, {add_special_tokens: false});
                return {ids, pieces: tokenizer.model.convert_ids_to_tokens(ids), addedTokens};
            },
            async forward(ids, attentionLength, past: ScoringPast | null) {
                const inputIds = new Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]);
                const mask = new Tensor('int64', new BigInt64Array(attentionLength).fill(1n), [1, attentionLength]);
                try {return await paceLocalInference(() => model({input_ids: inputIds, attention_mask: mask, past_key_values: past})) as unknown as Record<string, ScoringTensor>;}
                finally {inputIds.dispose(); mask.dispose();}
            },
            yield: () => new Promise(resolve => setTimeout(resolve, 0)),
        };
        return engine;
        }).catch(error => {creating = undefined; throw error;});
    };
    self.addEventListener('message', (event: MessageEvent<InformationHighlightWorkerRequest>) => {
        const request = event.data;
        if (!request || !Number.isSafeInteger(request.requestId)) return;
        if (request.type === 'cancel') {controllers.get(request.requestId)?.abort(); return;}
        if (request.type !== 'score' || controllers.has(request.requestId) || typeof request.text !== 'string') return;
        const descriptor = getInformationHighlightModel(request.modelId);
        if (request.modelId !== undefined && descriptor.id !== request.modelId) {
            self.postMessage({requestId: request.requestId, success: false, initialized: Boolean(engine), error: 'INFORMATION_HIGHLIGHT_INVALID_MODEL'} satisfies InformationHighlightWorkerResponse); return;
        }
        const controller = new AbortController(); controllers.set(request.requestId, controller);
        const run = async () => {
            try {
                if (controller.signal.aborted) throw new DOMException('信息高亮已取消', 'AbortError');
                if (!engine) self.postMessage({requestId: request.requestId, success: true, initialized: false, stage: 'initializing'} satisfies InformationHighlightWorkerResponse);
                const loaded = await getEngine(descriptor.id);
                if (controller.signal.aborted) throw new DOMException('信息高亮已取消', 'AbortError');
                self.postMessage({requestId: request.requestId, success: true, initialized: true, stage: 'scoring'} satisfies InformationHighlightWorkerResponse);
                const cached = results.get(request.text!);
                const result = cached ?? await scoreLocalSurprisal(loaded, request.text!, controller.signal);
                if (!cached) results.put(request.text!, result);
                self.postMessage({requestId: request.requestId, success: true, initialized: true, result} satisfies InformationHighlightWorkerResponse);
            } catch (error) {
                self.postMessage({requestId: request.requestId, success: false, initialized: Boolean(engine), error: error instanceof Error ? error.message : 'INFORMATION_HIGHLIGHT_FAILED'} satisfies InformationHighlightWorkerResponse);
            } finally {controllers.delete(request.requestId);}
        };
        tail = tail.then(run, run);
    });
}
