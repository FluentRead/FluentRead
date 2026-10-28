/**
 * @file src/shared/dom/downloadTextFile.ts
 * 文件职责：为用户主动导出的文本创建临时下载地址，并在成功和失败路径释放该地址。
 * 主要内容：保持下载后的短延迟以供浏览器读取；同步启动或计时器登记失败时立即尝试撤销并保留原错误。
 * 模块边界：不决定导出内容、用户确认、生命周期或成功提示；调用方负责授权和反馈。
 */
export function downloadTextFile(name: string, body: string, type: string): number {
    const blob = new Blob([body], {type});
    const url = URL.createObjectURL(blob);
    const revoke = () => {try {URL.revokeObjectURL(url);} catch { /* 清理失败不能覆盖原始导出错误。 */ }};
    try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = name;
        anchor.click();
        window.setTimeout(revoke, 1000);
        return blob.size;
    } catch (error) {
        revoke();
        throw error;
    }
}
