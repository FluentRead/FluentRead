/**
 * @file src/features/settings/model/googleDrivePreview.ts
 * 文件职责：把安全同步差异整理为用户可以理解和选择的预览行。
 * 主要内容：识别首次保存、首次恢复、只读恢复和一致状态；按名称及推荐方向收拢重复摘要，
 * 统计实际待选择项并展开整组选择，保留差异 ID 与自动推荐，按界面语言显示已脱敏语言名称。
 * 模块边界：只处理已经脱敏的预览；不读取配置、凭据、账号缓存或执行网络请求。
 */
import type {DriveChoice, DriveSyncChange} from '@/src/core/config/driveSync';
import type {DriveSyncDirection, DriveSyncPreview} from '@/src/services/config/googleDriveSync';
import {getMultilingualTargetLanguageLabel, options} from '@/src/core/config/catalog';

export interface DrivePreviewRow {
    id: string;
    label: string;
    changes: DriveSyncChange[];
    recommended: DriveChoice | null;
}
export function initialDriveDirection(preview: DriveSyncPreview): DriveSyncDirection | '' {
    if (!preview.hasRemote) return 'upload';
    if (preview.canUpload === false) return 'download';
    const hasLearningChanges = Boolean(preview.learningSummary?.hasAnyChanges);
    const upgradingEncryption = preview.keyMode === 'custom' && preview.remoteKeyMode === 'app';
    if (!preview.changes.length && !hasLearningChanges && !upgradingEncryption) return 'download';
    return preview.hasBaseline ? 'merge' : '';
}
export function localizeDrivePreviewLanguage(value: string, uiLanguage: string): string {
    const option = options.from.find(option => option.label === value);
    return option ? getMultilingualTargetLanguageLabel(option.value, value, uiLanguage) : value;
}
export function groupDrivePreviewChanges(changes: DriveSyncChange[]): DrivePreviewRow[] {
    const groups = new Map<string, DrivePreviewRow>();
    for (const change of changes) {
        const key = JSON.stringify([change.label, change.recommended]);
        const group = groups.get(key);
        if (group) group.changes.push(change);
        else groups.set(key, {id: change.id, label: change.label, recommended: change.recommended, changes: [change]});
    }
    return [...groups.values()];
}
export function driveRowChoice(row: DrivePreviewRow, choices: Record<string, string>): DriveChoice | '' {
    const first = choices[row.changes[0].id];
    return (first === 'local' || first === 'remote') && row.changes.every(change => choices[change.id] === first) ? first : '';
}
export function unresolvedDriveChanges(preview: DriveSyncPreview, choices: Record<string, string>): number {
    return preview.changes.filter(change => choices[change.id] !== 'local' && choices[change.id] !== 'remote').length;
}
export function chooseDriveRow(row: DrivePreviewRow, choice: DriveChoice, choices: Record<string, string>): Record<string, string> {
    return {...choices, ...Object.fromEntries(row.changes.map(change => [change.id, choice]))};
}
