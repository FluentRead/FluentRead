/** i18n 源码扫描结果；只返回界面候选文案与文件位置。 */
export function collectUiSourceCopy(root: string): {
    files: string[];
    sources: Array<{source: string; files: string[]}>;
};
