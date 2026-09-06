/** 构建期空适配器：明确隔离必须依赖扩展专属 API 的功能。 */
export function mountAreaTranslator(): undefined {
    return undefined;
}

export function unmountAreaTranslator(): void {}

export function isAreaTranslatorMounted(): boolean {
    return false;
}

export function mountImageTranslator(): void {}

export function unmountImageTranslator(): void {}

export function mountNewApiComponent(): void {}

export function unmountNewApiComponent(): void {}

export function mountVideoSubtitleTranslation(): () => void {
    return () => undefined;
}

/** Userscript 不注入 YouTube/X MAIN-world bridge，因此始终关闭扩展专属字幕 runtime。 */
export function isSupportedVideoPage(): boolean {
    return false;
}

export function toggleContextMenuImage(): boolean { return false; }
