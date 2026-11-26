import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {sharedOnnxBuildPlugin, sharedOnnxDist} from '../scripts/wasm/manga-onnx-build';
describe('共享 ONNX 构建', () => {
    it('所有浏览器模型复用已锁定版本的 WebGPU/CPU 与 Tensor ABI，排除内嵌 glue 和其他包', () => {
        const plugin = sharedOnnxBuildPlugin();
        for (const source of ['onnxruntime-web', 'onnxruntime-web/webgpu']) {
            expect(plugin.resolveId(source)).toBe(resolve(sharedOnnxDist(), 'ort.webgpu.min.mjs'));
        }
        const common = plugin.resolveId('onnxruntime-common')!;
        expect(readFileSync(common, 'utf8')).toContain('export');
        expect(common).toContain('onnxruntime-common@1.24.0-dev.20251116-b39e144322');
        expect(plugin.resolveId('onnxruntime-node')).toBeNull();
        expect(plugin.resolveId('other-package')).toBeNull();
        expect(readFileSync(resolve(sharedOnnxDist(), 'ort-wasm-simd-threaded.asyncify.wasm')).subarray(0, 4)).toEqual(Buffer.from([0,97,115,109]));
        expect(readFileSync(resolve(sharedOnnxDist(), 'ort-wasm-simd-threaded.jspi.wasm')).subarray(0, 4)).toEqual(Buffer.from([0,97,115,109]));
    });
});
