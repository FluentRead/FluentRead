/**
 * @file src/app/background/contextMenuDelivery.ts
 * 文件职责：为右键菜单的状态读取、动作确认和反馈交付设置有限等待，避免失去回复的消息永久占用点击队列。
 * 主要内容：包装一次既有请求，超时拒绝等待并在所有退出路径释放计时器；迟到的请求结果不会改变已结束的等待。
 * 模块边界：这里只约束等待时间，不发消息、不自动重试或取消页面翻译；调用方仍拥有文档归属、动作语义及用户反馈。
 */
export async function withContextMenuDeadline<T>(request: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Context menu response timed out')), timeoutMs);
    });
    try {
        return await Promise.race([request, timeout]);
    } finally {
        clearTimeout(timer);
    }
}
