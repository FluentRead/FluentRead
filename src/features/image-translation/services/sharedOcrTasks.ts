/**
 * @file src/features/image-translation/services/sharedOcrTasks.ts
 * 文件职责：合并同一图片、识别语言与处理策略的在途 OCR，避免多个页面或重复触发把相同图片串行识别多遍。
 * 主要内容：按键共享执行任务与真实进度，调用方各自订阅和取消；最后一位调用方退出才取消底层任务，失败和取消立即移除任务，迟到结果不能覆盖重试。
 * 模块边界：不读取图片、不缓存完成结果、不访问浏览器或识别引擎；调用层生成策略键、复制结果并维护有界缓存。
 */
type Outcome<T> = {result: T} | {error: unknown};
type Subscriber<T> = {finish: (outcome: Outcome<T>) => void; progress?: (percent: number) => void};
type SharedTask<T> = {controller: AbortController; subscribers: Set<Subscriber<T>>; percent?: number};

export function createOcrAbortError(): Error {
    const error = new Error('图片 OCR 请求已取消');
    error.name = 'AbortError';
    return error;
}

function notify<T>(subscriber: Subscriber<T>, percent: number): void {
    try { subscriber.progress?.(percent); } catch { /* 展示回调不能影响其他调用方的识别。 */ }
}

export function createSharedOcrTasks<T>() {
    const tasks = new Map<string, SharedTask<T>>();
    return {
        run(key: string, operation: (signal: AbortSignal, progress: (percent: number) => void) => Promise<T>,
            signal?: AbortSignal, progress?: (percent: number) => void): Promise<T> {
            if (signal?.aborted) return Promise.reject(createOcrAbortError());
            const existing = tasks.get(key);
            const task = existing ?? {controller: new AbortController(), subscribers: new Set<Subscriber<T>>()};
            tasks.set(key, task);
            const result = new Promise<T>((resolve, reject) => {
                const subscriber: Subscriber<T> = {
                    progress,
                    finish(outcome) {
                        if (!task.subscribers.delete(subscriber)) return;
                        signal?.removeEventListener('abort', cancel);
                        if ('error' in outcome) reject(outcome.error); else resolve(outcome.result);
                    },
                };
                const cancel = () => {
                    subscriber.finish({error: createOcrAbortError()});
                    if (task.subscribers.size === 0) {
                        if (tasks.get(key) === task) tasks.delete(key);
                        task.controller.abort();
                    }
                };
                task.subscribers.add(subscriber);
                signal?.addEventListener('abort', cancel, {once: true});
                if (task.percent !== undefined) notify(subscriber, task.percent);
            });
            if (!existing) {
                const finish = (outcome: Outcome<T>) => {
                    if (tasks.get(key) === task) tasks.delete(key);
                    for (const subscriber of task.subscribers) subscriber.finish(outcome);
                };
                // 同步开始准备图片，借用调用方已解码的图片时不跨过其释放时机。
                void (async () => operation(task.controller.signal, percent => {
                    if (task.controller.signal.aborted) return;
                    task.percent = percent;
                    for (const subscriber of task.subscribers) notify(subscriber, percent);
                }))().then(result => finish({result}), error => finish({error}));
            }
            return result;
        },
    };
}
