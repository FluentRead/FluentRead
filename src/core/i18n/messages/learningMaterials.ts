/**
 * @file src/core/i18n/messages/learningMaterials.ts
 * 文件职责：集中维护学习材料、来源恢复与本机备份的旧模板界面译文。
 * 主要内容：导出六种非中文语言的精确词典及保留数量、页码、时间参数的动态模板。
 * 模块边界：仅声明界面资源；不翻译用户原文、标题与笔记，不读取材料或配置。
 */
import type {LocalizedLegacyPattern} from '../types';
import zhTW from './learning-materials/zh-TW.json';
import enUS from './learning-materials/en-US.json';
import jaJP from './learning-materials/ja-JP.json';
import koKR from './learning-materials/ko-KR.json';
import frFR from './learning-materials/fr-FR.json';
import ruRU from './learning-materials/ru-RU.json';
import esES from './learning-materials/es-ES.json';

export const learningMaterialLegacyText = {
    'zh-TW': zhTW,
    'en-US': enUS,
    'ja-JP': jaJP,
    'ko-KR': koKR,
    'fr-FR': frFR,
    'ru-RU': ruRU,
    'es-ES': esES,
} as const;

export const learningMaterialPatterns: readonly LocalizedLegacyPattern[] = [
    {pattern: '^(\\d+) 条学习内容$', localizedCaptures: [], messages: {
        'zh-TW': '{1} 條學習內容',
        'en-US': '{1} learning items',
        'ja-JP': '学習内容 {1} 件',
        'ko-KR': '학습 내용 {1}개',
        'fr-FR': '{1} éléments d’apprentissage',
        'ru-RU': 'Учебных записей: {1}',
        'es-ES': '{1} elementos de aprendizaje',
    }},
    {pattern: '^显示更多材料（(\\d+) / (\\d+)）$', localizedCaptures: [], messages: {
        'zh-TW': '顯示更多材料（{1} / {2}）',
        'en-US': 'Show more materials ({1} / {2})',
        'ja-JP': '資料をさらに表示（{1} / {2}）',
        'ko-KR': '자료 더 보기 ({1} / {2})',
        'fr-FR': 'Voir plus de ressources ({1} / {2})',
        'ru-RU': 'Ещё материалы ({1} / {2})',
        'es-ES': 'Mostrar más materiales ({1} / {2})',
    }},
    {pattern: '^继续第 (\\d+) 页$', localizedCaptures: [], messages: {
        'zh-TW': '繼續第 {1} 頁',
        'en-US': 'Continue on page {1}',
        'ja-JP': '{1} ページから再開',
        'ko-KR': '{1}페이지부터 이어 읽기',
        'fr-FR': 'Reprendre à la page {1}',
        'ru-RU': 'Продолжить со страницы {1}',
        'es-ES': 'Continuar en la página {1}',
    }},
    {pattern: '^上次看到 (\\d+):(\\d+)$', localizedCaptures: [], messages: {
        'zh-TW': '上次看到 {1}:{2}',
        'en-US': 'Last watched at {1}:{2}',
        'ja-JP': '前回の再生位置 {1}:{2}',
        'ko-KR': '마지막 시청 위치 {1}:{2}',
        'fr-FR': 'Dernière position : {1}:{2}',
        'ru-RU': 'Последняя позиция: {1}:{2}',
        'es-ES': 'Última posición: {1}:{2}',
    }},
    {pattern: '^没有恢复材料，跳过 (\\d+) 条无效、冲突或较旧的记录。$', localizedCaptures: [], messages: {
        'zh-TW': '沒有還原材料，略過 {1} 條無效、衝突或較舊的紀錄。',
        'en-US': 'No materials restored. Skipped {1} invalid, conflicting or older records.',
        'ja-JP': '資料は復元されませんでした。無効、競合、または古い記録 {1} 件をスキップしました。',
        'ko-KR': '복원된 자료가 없습니다. 유효하지 않거나 충돌하거나 오래된 기록 {1}개를 건너뛰었습니다.',
        'fr-FR': 'Aucune ressource restaurée. {1} enregistrements invalides, en conflit ou plus anciens ont été ignorés.',
        'ru-RU': 'Материалы не восстановлены. Пропущено недопустимых, конфликтующих или устаревших записей: {1}.',
        'es-ES': 'No se restauraron materiales. Se omitieron {1} registros no válidos, en conflicto o más antiguos.',
    }},
    {pattern: '^已恢复 (\\d+) 份材料（新增 (\\d+) · 更新 (\\d+) · 跳过 (\\d+)）。$', localizedCaptures: [], messages: {
        'zh-TW': '已還原 {1} 份材料（新增 {2} · 更新 {3} · 略過 {4}）。',
        'en-US': 'Restored {1} materials (added {2} · updated {3} · skipped {4}).',
        'ja-JP': '資料 {1} 件を復元しました（新規 {2} · 更新 {3} · スキップ {4}）。',
        'ko-KR': '자료 {1}개를 복원했습니다 (추가 {2} · 수정 {3} · 건너뜀 {4}).',
        'fr-FR': '{1} ressources restaurées (ajoutées {2} · mises à jour {3} · ignorées {4}).',
        'ru-RU': 'Восстановлено материалов: {1} (добавлено {2} · обновлено {3} · пропущено {4}).',
        'es-ES': 'Se restauraron {1} materiales (añadidos {2} · actualizados {3} · omitidos {4}).',
    }},
];
