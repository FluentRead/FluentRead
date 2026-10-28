/**
 * @file src/app/background/handlers/trustedSettingsSender.ts
 * 文件职责：为后台敏感操作校验消息来自当前扩展的设置页面。
 * 主要内容：匹配扩展 ID、URL 协议、主机和 options 路径，允许查询与锚点。
 * 模块边界：只校验发送来源，不授予任何具体功能权限；各 handler 仍需执行自己的额外条件。
 */
import type {ConfigPersistenceContext} from './configPersistence';

export function isTrustedSettingsSender(sender: ConfigPersistenceContext['sender'], extensionId: string, optionsUrl: string): boolean {
    if (!sender?.url || sender.id !== extensionId) return false;
    try {
        const source = new URL(sender.url);
        const expected = new URL(optionsUrl);
        return source.protocol === expected.protocol && source.host === expected.host && source.pathname === expected.pathname;
    } catch {return false;}
}
