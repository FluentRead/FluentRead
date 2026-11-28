/**
 * @file src/features/video-subtitle/content/video-ai/pcmWorklet.ts
 * 文件职责：在音频渲染线程注册 FluentRead 的只读 PCM 采集器。
 * 主要内容：单声道采用块拷贝快速路径，多声道按实际输入长度混音，每 2048 个采样转移一块独立缓冲，并支持显式 flush 消息冲刷尾部残留样本，输出保持静音，避免在网页主线程执行逐采样回调。
 * 模块边界：仅处理浏览器提供的音频块和独立 MessagePort；不访问网页、网络、模型或用户配置，生命周期由拥有 AudioContext 的采集控制器负责。
 */
export interface PcmWorkletPort extends Pick<MessagePort, 'postMessage'> {
    onmessage?: ((event: {data?: unknown}) => void) | null;
}

export interface PcmWorkletScope {
    AudioWorkletProcessor: new () => {readonly port: PcmWorkletPort};
    registerProcessor: (name: string, processor: new () => {process(inputs: Float32Array[][]): boolean}) => void;
    sampleRate: number;
}

export function registerVideoPcmWorklet(scope: PcmWorkletScope): void {
    class VideoPcmProcessor extends scope.AudioWorkletProcessor {
        private block = new Float32Array(2048);
        private filled = 0;

        constructor() {
            super();
            this.port.onmessage = (event) => {
                const payload = event?.data as {type?: unknown} | null | undefined;
                if (payload?.type === 'flush') this.flush();
            };
        }

        private flush(): void {
            if (this.filled === 0) return;
            const pcm = this.block.slice(0, this.filled);
            this.filled = 0;
            this.port.postMessage({pcm, sampleRate: scope.sampleRate}, [pcm.buffer]);
        }

        process(inputs: Float32Array[][]): boolean {
            const channels = inputs[0];
            if (!channels?.length) return true;
            const input = channels[0];
            let offset = 0;
            while (offset < input.length) {
                const count = Math.min(this.block.length - this.filled, input.length - offset);
                if (channels.length === 1) {
                    this.block.set(input.subarray(offset, offset + count), this.filled);
                } else {
                    for (let index = 0; index < count; index++) {
                        let value = 0;
                        for (const channel of channels) value += channel[offset + index];
                        this.block[this.filled + index] = value / channels.length;
                    }
                }
                this.filled += count;
                offset += count;
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
