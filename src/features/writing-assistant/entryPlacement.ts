/**
 * @file src/features/writing-assistant/entryPlacement.ts
 * 文件职责：把写作入口放入各一等支持网站的原生操作行。
 * 主要内容：锁定入口宿主的布局身份，并按站点约定将宿主放在原生发送、评论或发布按钮之前或之后；Gmail 维持在发送按钮之后，GitHub、Outlook、X、Reddit、LinkedIn、Slack、Discord 与 Notion 放在操作按钮之前。
 * 模块边界：只处理入口宿主的 DOM 布局，不读取网页内容、不定位模型面板。
 */
import type {FirstClassWritingSite} from '@/src/core/config/writing';
import {WRITING_SITE_PROFILES} from './siteProfiles';

export type WritingEntrySite = FirstClassWritingSite;

const WRITING_ENTRY_HOST_STYLE = [
    'all:initial !important',
    'display:inline-flex !important',
    'align-items:center !important',
    'justify-content:center !important',
    'position:static !important',
    'vertical-align:middle !important',
    'flex:0 0 auto !important',
    'width:auto !important',
    'height:32px !important',
    'margin-inline:4px !important',
    'padding:0 !important',
    'border:0 !important',
    'line-height:0 !important',
    'white-space:nowrap !important',
    'z-index:auto !important',
].join(';');

export function prepareWritingEntryHost(host: HTMLElement): void {
    host.style.cssText = WRITING_ENTRY_HOST_STYLE;
}

/** 将入口作为原生操作行的真实子节点插入，而不是放在页面上方的 fixed 浮层。 */
export function placeWritingEntry(action: HTMLElement, host: HTMLElement, site: WritingEntrySite): boolean {
    const parent = action.parentElement;
    if (!action.isConnected || !parent) return false;
    if (WRITING_SITE_PROFILES[site].placement === 'before') {
        if (action.previousElementSibling !== host) parent.insertBefore(host, action);
    } else if (action.nextElementSibling !== host) {
        parent.insertBefore(host, action.nextSibling);
    }
    return host.parentElement === parent;
}
