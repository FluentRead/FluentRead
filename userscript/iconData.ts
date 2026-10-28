/**
 * @file userscript/iconData.ts
 * 文件职责：恢复 standalone 的无损内嵌图标数据，其他脚本保留原地址。
 * 模块边界：只转换已打包的 PNG 字节，不读取网络或更改图像。
 */
import {decodeUserscriptData, USERSCRIPT_DATA_PREFIX} from './dataEncoding';

export function restoreUserscriptIcon(value: string): string {
    if (!value.startsWith(USERSCRIPT_DATA_PREFIX)) return value;
    return `data:image/png;base64,${btoa(String.fromCharCode(...decodeUserscriptData(value)))}`;
}
