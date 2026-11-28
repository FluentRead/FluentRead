/**
 * @file src/shared/onnx/webgpu.ts
 * 文件职责：为本地音频及漫画模型探测可用的硬件 WebGPU，避免软件适配器、低能力显存限制与卡住的探测阻塞 CPU 回退。
 * 主要内容：有界请求高性能适配器、过滤软件渲染器与低于安全显存/工作组上限的适配器，并返回诊断名称。
 * 模块边界：不创建 GPU device 或模型，不读取配置；失败后的设备选择和会话释放由各运行时管理。
 */

export interface WebGpuProbeResult {
    available: boolean;
    info: string;
}

interface AdapterInfo {
    isFallbackAdapter?: boolean;
    vendor?: string;
    architecture?: string;
    device?: string;
    description?: string;
}

interface AdapterLimits {
    maxStorageBufferBindingSize?: number;
    maxBufferSize?: number;
    maxComputeWorkgroupStorageSize?: number;
}

interface ProbeNavigator {
    gpu?: {requestAdapter(options: {powerPreference: 'high-performance'}): Promise<{
        isFallbackAdapter?: boolean;
        info?: AdapterInfo;
        limits?: AdapterLimits;
    } | null>};
}

const MIN_STORAGE_BUFFER_BINDING_SIZE = 128 * 1024 * 1024;
const MIN_BUFFER_SIZE = 256 * 1024 * 1024;
const MIN_COMPUTE_WORKGROUP_STORAGE_SIZE = 16_384;

function hasInsufficientAdapterLimits(limits: AdapterLimits | undefined): boolean {
    if (!limits) return false;
    return (typeof limits.maxStorageBufferBindingSize === 'number'
        && limits.maxStorageBufferBindingSize < MIN_STORAGE_BUFFER_BINDING_SIZE)
        || (typeof limits.maxBufferSize === 'number'
            && limits.maxBufferSize < MIN_BUFFER_SIZE)
        || (typeof limits.maxComputeWorkgroupStorageSize === 'number'
            && limits.maxComputeWorkgroupStorageSize < MIN_COMPUTE_WORKGROUP_STORAGE_SIZE);
}

/** 探测不分配显存；驱动无响应超过两秒或硬件上限不足时，本次处理直接使用 CPU。 */
export async function probeWebGpu(): Promise<WebGpuProbeResult> {
    const unavailable = {available: false, info: ''};
    let result = unavailable;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const runtimeNavigator = globalThis.navigator as ProbeNavigator | undefined;
        if (typeof runtimeNavigator?.gpu?.requestAdapter !== 'function') return unavailable;
        const adapter = await Promise.race([
            runtimeNavigator.gpu.requestAdapter({powerPreference: 'high-performance'}),
            new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 2_000); }),
        ]);
        if (adapter) {
            const adapterInfo = adapter.info;
            const info = [adapterInfo?.vendor, adapterInfo?.architecture, adapterInfo?.device, adapterInfo?.description]
                .filter(Boolean).join(' / ');
            const software = adapter.isFallbackAdapter === true || adapterInfo?.isFallbackAdapter === true
                || /swiftshader|software|llvmpipe|fallback/i.test(info);
            const unusable = software || hasInsufficientAdapterLimits(adapter.limits);
            result = {available: !unusable, info: unusable ? '' : info};
        }
    } catch {
        // 能力或驱动异常均视为不可用，由调用方继续 CPU 路径。
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
    return result;
}
