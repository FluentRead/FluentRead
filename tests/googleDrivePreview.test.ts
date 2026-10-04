import {describe, expect, it} from 'vitest';
import {chooseDriveRow, driveRowChoice, groupDrivePreviewChanges, initialDriveDirection, localizeDrivePreviewLanguage, unresolvedDriveChanges} from '@/src/features/settings/model/googleDrivePreview';
import type {DriveSyncChange} from '@/src/core/config/driveSync';
import type {DriveSyncPreview} from '@/src/services/config/googleDriveSync';
const change = (id: string, label: string, recommended: 'local' | 'remote' | null = null): DriveSyncChange => ({id, label, sensitive: true, local: 'hidden', remote: 'hidden', conflict: recommended === null, recommended});
const preview = (patch: Partial<DriveSyncPreview> = {}): DriveSyncPreview => ({id: 'fixture', account: {id: 'a', email: 'a@fixture.invalid'}, includeSensitive: false, remoteIncludesSensitive: false, hasRemote: true, hasBaseline: false, changes: [change('0', 'theme')], expiresAt: 1000, ...patch});
describe('Google Drive 操作和预览模型', () => {
    it('预览语言名称跟随界面语言，英文不残留中文组合名称，其他摘要保持原样', () => {
        expect(localizeDrivePreviewLanguage('Deutsch / German / 德语', 'en-US')).toBe('German');
        expect(localizeDrivePreviewLanguage('简体中文', 'en-US')).toBe('Simplified Chinese');
        for (const [locale, name] of [['zh-CN','德语'],['ja-JP','ドイツ語'],['ko-KR','독일어'],['fr-FR','allemand'],['ru-RU','немецкий'],['es-ES','Alemán']]) expect(localizeDrivePreviewLanguage('Deutsch / German / 德语', locale)).toContain(name);
        expect(localizeDrivePreviewLanguage('已设置（内容隐藏）', 'en-US')).toBe('已设置（内容隐藏）');
        expect(localizeDrivePreviewLanguage('fixture unknown summary', 'en-US')).toBe('fixture unknown summary');
    });
    it('首次保存只有上传；首次恢复不暗选方向；有基线默认合并；一致时完成而不覆盖云端', () => {
        expect(initialDriveDirection(preview({hasRemote: false, changes: []}))).toBe('upload');
        expect(initialDriveDirection(preview())).toBe('');
        expect(initialDriveDirection(preview({hasBaseline: true}))).toBe('merge');
        expect(initialDriveDirection(preview({changes: []}))).toBe('download');
        expect(initialDriveDirection(preview({hasBaseline:true,canUpload:false}))).toBe('download');
    });
    it('收拢同名兼容字段，但保留不同推荐方向和真实差异 ID', () => {
        const rows = groupDrivePreviewChanges([change('0', 'other'), change('1', 'other'), change('2', 'other', 'local'), change('3', 'other', 'remote'), change('4', 'theme')]);
        expect(rows).toHaveLength(4);
        expect(rows[0].changes.map(change => change.id)).toEqual(['0', '1']);
        expect(rows.map(row => row.recommended)).toEqual([null, 'local', 'remote', null]);
        expect(groupDrivePreviewChanges([])).toEqual([]);
    });
    it('整组选一端会解决全部成员，保留其他选择；混合或无效选择仍待确认', () => {
        const rows = groupDrivePreviewChanges([change('0', 'other'), change('1', 'other')]);
        const row = rows[0];
        const incompleteChoices: Record<string, string>[] = [{}, {'0': 'local'}, {'0': 'local', '1': 'remote'}, {'0': 'invalid', '1': 'invalid'}];
        for (const choices of incompleteChoices) expect(driveRowChoice(row, choices)).toBe('');
        const selected = chooseDriveRow(row, 'remote', {'2': 'local'});
        expect(selected).toEqual({'0': 'remote', '1': 'remote', '2': 'local'});
        expect(driveRowChoice(row, selected)).toBe('remote');
        expect(unresolvedDriveChanges(preview({changes: row.changes}), selected)).toBe(0);
        expect(unresolvedDriveChanges(preview({changes: row.changes}), {'0': 'local', '1': 'invalid'})).toBe(1);
    });
});
