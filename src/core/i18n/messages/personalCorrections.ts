/**
 * @file src/core/i18n/messages/personalCorrections.ts
 * 文件职责：提供个人校订面板中与用户项目、网页名称相邻的界面文案。
 * 主要内容：显式登记七语范围标签和章节回退，通过命名参数保留用户名称与各语言语序；中文常量独立导出，运行时引用它时无需保留构建期七语聚合表。
 * 模块边界：这里只描述界面文案，不接收或改写原文、译文、项目名称和章节内容；旧模板仍由迁移适配层处理。
 */
import type {MessageCatalog, UiLanguage} from '../types';

export const personalCorrectionChineseMessages = {
    'personalCorrections.projectName': '项目：{name}',
    'personalCorrections.pageName': '网页：{name}',
    'personalCorrections.noChapter': '此处没有章节标题',
    'personalCorrections.currentPage': '仅当前网页',
    'personalCorrections.project': '项目',
} as const;

export const personalCorrectionMessages = {
    'zh-CN': personalCorrectionChineseMessages,
    'zh-TW': {
        'personalCorrections.projectName': '專案：{name}',
        'personalCorrections.pageName': '網頁：{name}',
        'personalCorrections.noChapter': '此處沒有章節標題',
        'personalCorrections.currentPage': '僅目前網頁',
        'personalCorrections.project': '專案',
    },
    'en-US': {
        'personalCorrections.projectName': 'Project: {name}',
        'personalCorrections.pageName': 'Page: {name}',
        'personalCorrections.noChapter': 'No section heading here',
        'personalCorrections.currentPage': 'This page only',
        'personalCorrections.project': 'Project',
    },
    'ja-JP': {
        'personalCorrections.projectName': 'プロジェクト：{name}',
        'personalCorrections.pageName': 'ページ：{name}',
        'personalCorrections.noChapter': 'ここにはセクション見出しがありません',
        'personalCorrections.currentPage': 'このページのみ',
        'personalCorrections.project': 'プロジェクト',
    },
    'ko-KR': {
        'personalCorrections.projectName': '프로젝트: {name}',
        'personalCorrections.pageName': '페이지: {name}',
        'personalCorrections.noChapter': '이 위치에는 섹션 제목이 없습니다',
        'personalCorrections.currentPage': '현재 페이지만',
        'personalCorrections.project': '프로젝트',
    },
    'fr-FR': {
        'personalCorrections.projectName': 'Projet : {name}',
        'personalCorrections.pageName': 'Page : {name}',
        'personalCorrections.noChapter': 'Aucun titre de section ici',
        'personalCorrections.currentPage': 'Cette page uniquement',
        'personalCorrections.project': 'Projet',
    },
    'ru-RU': {
        'personalCorrections.projectName': 'Проект: {name}',
        'personalCorrections.pageName': 'Страница: {name}',
        'personalCorrections.noChapter': 'Здесь нет заголовка раздела',
        'personalCorrections.currentPage': 'Только эта страница',
        'personalCorrections.project': 'Проект',
    },
    'es-ES': {
        'personalCorrections.projectName': 'Proyecto: {name}',
        'personalCorrections.pageName': 'Página: {name}',
        'personalCorrections.noChapter': 'Aquí no hay un título de sección',
        'personalCorrections.currentPage': 'Solo esta página',
        'personalCorrections.project': 'Proyecto',
    },
} as const satisfies Readonly<Record<UiLanguage, MessageCatalog>>;
