/**
 * @file userscript/readingGeneration.ts
 * 文件职责：在独立 userscript 中复用到轻量共享流式模型网关的阅读生成端口。
 * 主要内容：直接委托 src/services/harness/modelGateway 的原生 HTTP/SSE 执行器，并保持与脚本构建一致的错误归一入口。
 * 模块边界：不引入 ChatGPT 套餐等扩展专用桥接，保持 userscript 产物体积紧凑；提示词、引用校验与会话仍由共享 Harness 执行。
 */
import type {Config} from '@/src/core/config/model';
import type {HarnessGenerate, HarnessToolDefinition} from '@/src/core/harness/loop';
import type {ModelUsageEvent} from '@/src/services/model-usage/types';
import {normalizeHarnessTransportError} from '@/src/services/harness/modelConfig';
import {createHarnessStreamExecutor} from '@/src/services/harness/modelGateway';

export const normalizeHarnessModelError = normalizeHarnessTransportError;

export function createHarnessGenerator(
    config: Config, service: string, model: string, tools: readonly HarnessToolDefinition[], recordUsage?: (event: ModelUsageEvent) => void,
): HarnessGenerate {
    return createHarnessStreamExecutor(config, service, model, tools, recordUsage);
}
