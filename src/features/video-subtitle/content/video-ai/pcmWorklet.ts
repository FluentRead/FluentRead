/**
 * @file src/features/video-subtitle/content/video-ai/pcmWorklet.ts
 * 文件职责：在音频渲染线程注册 FluentRead 的只读 PCM 采集器。
 * 主要内容：按实际输入长度混合声道，每 2048 个采样转移一块独立缓冲，输出保持静音，避免在网页主线程执行逐采样回调。
 * 模块边界：仅处理浏览器提供的音频块和独立 MessagePort；不访问网页、网络、模型或用户配置，生命周期由拥有 AudioContext 的采集控制器负责。
 */
export interface PcmWorkletScope {
    AudioWorkletProcessor: new () => {readonly port: Pick<MessagePort, 'postMessage'>};
    registerProcessor: (name: string, processor: new () => {process(inputs: Float32Array[][]): boolean}) => void;
    sampleRate: number;
}

export function registerVideoPcmWorklet(scope: PcmWorkletScope): void {
    class VideoPcmProcessor extends scope.AudioWorkletProcessor {
        private block = new Float32Array(2048);
        private filled = 0;
        process(inputs: Float32Array[][]): boolean {
            const channels = inputs[0];
            if (!channels?.length) return true;
            for (let sample = 0; sample < channels[0].length; sample++) {
                let value = 0;
                for (const channel of channels) value += channel[sample];
                this.block[this.filled++] = value / channels.length;
                if (this.filled === this.block.length) {
                    const pcm = this.block;
                    this.port.postMessage({pcm, sampleRate: scope.sampleRate}, [pcm.buffer]);
                    this.block = new Float32Array(2048);
                    this.filled = 0;
                }
            }
            return true;
        }
    }
    scope.registerProcessor('fluent-read-video-pcm', VideoPcmProcessor);
}
