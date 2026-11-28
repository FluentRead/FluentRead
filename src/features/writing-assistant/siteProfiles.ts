/**
 * @file src/features/writing-assistant/siteProfiles.ts
 * 文件职责：集中维护写作助手一等支持网站的域名映射、编辑器选择器、操作按钮锚点与安全上下文采集配置。
 * 主要内容：覆盖 Gmail、GitHub、Outlook、X、Reddit、LinkedIn、Slack、Discord 与 Notion 九类跨国沟通协作平台，定义原生入口前后位置、纯文本或 Markdown 输出模式、会话作用域、主题字段及最近消息采集规则。
 * 模块边界：只提供纯声明式站点配置与域名解析函数，不查询 DOM、不监听事件、不读取扩展配置也不执行网络请求。
 */
import type {FirstClassWritingSite} from '@/src/core/config/writing';

export type WritingSite = FirstClassWritingSite | 'generic' | null;

export interface WritingSiteProfile {
    readonly site: FirstClassWritingSite;
    readonly editorSelector: string;
    readonly richEditorSelector: string;
    readonly composerScopeSelector: string;
    readonly actionSelector: string;
    readonly placement: 'before' | 'after';
    readonly plainTextOutput: boolean;
    readonly contextRootSelector: string;
    readonly titleSelector: string;
    readonly titleLabel: string;
    readonly subjectInputSelector: string;
    readonly snippetSelector: string;
    readonly sectionLabel: string;
    readonly authorContainerSelector: string;
    readonly authorSelector: string;
}

const HOST_TO_SITE: Readonly<Record<string, FirstClassWritingSite>> = {
    'mail.google.com': 'gmail',
    'github.com': 'github',
    'outlook.live.com': 'outlook',
    'outlook.office.com': 'outlook',
    'outlook.office365.com': 'outlook',
    'x.com': 'x',
    'twitter.com': 'x',
    'reddit.com': 'reddit',
    'www.reddit.com': 'reddit',
    'old.reddit.com': 'reddit',
    'sh.reddit.com': 'reddit',
    'linkedin.com': 'linkedin',
    'www.linkedin.com': 'linkedin',
    'app.slack.com': 'slack',
    'discord.com': 'discord',
    'ptb.discord.com': 'discord',
    'canary.discord.com': 'discord',
    'notion.so': 'notion',
    'www.notion.so': 'notion',
};

export const WRITING_SITE_PROFILES: Readonly<Record<FirstClassWritingSite, WritingSiteProfile>> = {
    gmail: {
        site: 'gmail',
        editorSelector: '[contenteditable="true"][role="textbox"]',
        richEditorSelector: '[contenteditable="true"][role="textbox"]',
        composerScopeSelector: 'form, [role="dialog"], .M9',
        actionSelector: '[role="button"][data-tooltip*="Enter"], [role="button"][aria-label*="Enter"], button[type="submit"]',
        placement: 'after',
        plainTextOutput: true,
        contextRootSelector: '[role="dialog"], .M9, [role="main"]',
        titleSelector: 'h2.hP, input[name="subjectbox"]',
        titleLabel: '邮件主题',
        subjectInputSelector: 'input[name="subjectbox"]',
        snippetSelector: '[role="main"] .a3s, [role="dialog"] .a3s, .M9 .a3s',
        sectionLabel: '当前邮件',
        authorContainerSelector: '',
        authorSelector: '',
    },
    github: {
        site: 'github',
        editorSelector: 'textarea[name="comment[body]"], textarea#new_comment_field, textarea[name="discussion[body]"], textarea[name="discussion_comment[body]"], [data-testid="comment-composer"] textarea, [data-testid="comment-box"] textarea, textarea[aria-labelledby="comment-composer-heading"]',
        richEditorSelector: '',
        composerScopeSelector: '[data-testid="comment-composer"], [data-testid="comment-box"], .js-inline-comment-form, form',
        actionSelector: '[data-testid="markdown-editor-footer"] button[data-variant="primary"], [data-testid="comment-button"], .js-comment-button, button[type="submit"]:not([name="comment_and_close"]), input[type="submit"]:not([name="comment_and_close"])',
        placement: 'before',
        plainTextOutput: false,
        contextRootSelector: 'main',
        titleSelector: 'main [data-testid="issue-title"], main bdi.js-issue-title, main .gh-header-title .js-issue-title',
        titleLabel: '帖子标题',
        subjectInputSelector: '',
        snippetSelector: 'main .js-comment-body, main .CommentBody, main [data-testid="markdown-body"]',
        sectionLabel: '当前讨论',
        authorContainerSelector: '[data-testid="issue-comment"], .js-comment, .timeline-comment',
        authorSelector: '[data-testid="issue-comment-header-author"], [data-testid="comment-author"], .timeline-comment-header .author',
    },
    outlook: {
        site: 'outlook',
        editorSelector: '[role="textbox"][contenteditable="true"]',
        richEditorSelector: '[role="textbox"][contenteditable="true"]',
        composerScopeSelector: '[data-app-section="MailCompose"], [role="dialog"], [role="region"], form, [role="main"]',
        actionSelector: 'button[data-testid="ComposeSendButton"], button[aria-label*="Send" i], button[aria-label*="发送"], button[title*="Send" i], button[title*="发送"], button[type="submit"]',
        placement: 'before',
        plainTextOutput: true,
        contextRootSelector: '[role="dialog"], [role="main"], [role="region"]',
        titleSelector: 'input[aria-label*="Subject" i], input[aria-label*="主题"], [data-testid="SubjectLine"], [role="heading"][aria-level="2"]',
        titleLabel: '邮件主题',
        subjectInputSelector: 'input[aria-label*="Subject" i], input[aria-label*="主题"]',
        snippetSelector: '[aria-label="Message body"], [aria-label="邮件正文"], [data-testid="MessageBody"], .ReadingPaneContent [role="document"], .rps_body',
        sectionLabel: '当前邮件',
        authorContainerSelector: '',
        authorSelector: '',
    },
    x: {
        site: 'x',
        editorSelector: '[data-testid="tweetTextarea_0"][contenteditable="true"], [data-testid="tweetTextarea_0"] [contenteditable="true"][role="textbox"], [role="textbox"][contenteditable="true"]',
        richEditorSelector: '[data-testid="tweetTextarea_0"][contenteditable="true"], [role="textbox"][contenteditable="true"]',
        composerScopeSelector: '[role="dialog"], [data-testid="inline_reply_offscreen"], form, [data-testid="primaryColumn"], main',
        actionSelector: '[data-testid="tweetButton"], [data-testid="tweetButtonInline"], [data-testid="dmComposerSendButton"], button[type="submit"]',
        placement: 'before',
        plainTextOutput: true,
        contextRootSelector: '[role="dialog"], [data-testid="primaryColumn"], main',
        titleSelector: '',
        titleLabel: '',
        subjectInputSelector: '',
        snippetSelector: 'article [data-testid="tweetText"]',
        sectionLabel: '当前推文',
        authorContainerSelector: 'article',
        authorSelector: '[data-testid="User-Name"]',
    },
    reddit: {
        site: 'reddit',
        editorSelector: 'shreddit-composer div[contenteditable="true"][role="textbox"], shreddit-composer textarea, div[contenteditable="true"][role="textbox"], .usertext-edit textarea, form textarea',
        richEditorSelector: 'div[contenteditable="true"][role="textbox"], [contenteditable="true"][role="textbox"]',
        composerScopeSelector: 'shreddit-composer, .usertext-edit, form, [role="dialog"]',
        actionSelector: 'button[slot="submit-button"], [data-testid="comment-submission-form-submit"], button.save, button[type="submit"]',
        placement: 'before',
        plainTextOutput: false,
        contextRootSelector: 'shreddit-comment, .comment, shreddit-post, [role="dialog"], main',
        titleSelector: 'h1[slot="title"], shreddit-post h1, [data-testid="post-content"] h1, a.title, input[name="title"], textarea[name="title"]',
        titleLabel: '帖子标题',
        subjectInputSelector: 'input[name="title"], textarea[name="title"]',
        snippetSelector: '[slot="comment"], [slot="text-body"], [data-testid="comment"], .usertext-body .md',
        sectionLabel: '当前讨论',
        authorContainerSelector: 'shreddit-comment, .comment',
        authorSelector: 'a[slot="authorName"], a.author',
    },
    linkedin: {
        site: 'linkedin',
        editorSelector: '.ql-editor[contenteditable="true"], [role="textbox"][contenteditable="true"]',
        richEditorSelector: '.ql-editor[contenteditable="true"], [role="textbox"][contenteditable="true"]',
        composerScopeSelector: '.msg-form, .comments-comment-box, .share-box-feed-entry__wrapper, [role="dialog"], form',
        actionSelector: '.msg-form__send-button, .comments-comment-box__submit-button, .share-actions__primary-action, button[type="submit"]',
        placement: 'before',
        plainTextOutput: true,
        contextRootSelector: '.msg-convo-wrapper, .feed-shared-update-v2, [role="dialog"], main',
        titleSelector: '.msg-overlay-bubble-header__title, .msg-entity-lockup__entity-title, h1',
        titleLabel: '会话主题',
        subjectInputSelector: '',
        snippetSelector: '.msg-s-event-listitem__body, .feed-shared-update-v2__description, .update-components-text, .comments-comment-item__main-content',
        sectionLabel: '当前讨论',
        authorContainerSelector: '.msg-s-message-group, .comments-comment-item, .feed-shared-update-v2',
        authorSelector: '.msg-s-message-group__name, .comments-post-meta__name-text, .update-components-actor__name',
    },
    slack: {
        site: 'slack',
        editorSelector: '[data-qa="message_input"] [contenteditable="true"], .ql-editor[contenteditable="true"], [role="textbox"][contenteditable="true"]',
        richEditorSelector: '[data-qa="message_input"] [contenteditable="true"], .ql-editor[contenteditable="true"], [role="textbox"][contenteditable="true"]',
        composerScopeSelector: '[data-qa="message_composer"], .c-texty_input_unstyled__container, .p-workspace__secondary_view, [role="dialog"], form, main',
        actionSelector: '[data-qa="texty_send_button"], button[aria-label*="Send" i], button[aria-label*="发送"], button[type="submit"]',
        placement: 'before',
        plainTextOutput: true,
        contextRootSelector: '.p-workspace__secondary_view, [data-qa="threads_flexpane"], [role="dialog"], main',
        titleSelector: '[data-qa="channel_name"], .p-view_header__channel_title, [role="heading"]',
        titleLabel: '频道主题',
        subjectInputSelector: '',
        snippetSelector: '[data-qa="message-text"], .c-message_kit__blocks .p-rich_text_section, .p-rich_text_block',
        sectionLabel: '当前消息',
        authorContainerSelector: '[data-qa="virtual-list-item"], .c-message_kit__gutter',
        authorSelector: '[data-qa="message_sender_name"], .c-message__sender_button',
    },
    discord: {
        site: 'discord',
        editorSelector: '[role="textbox"][data-slate-editor="true"], [role="textbox"][contenteditable="true"]',
        richEditorSelector: '[role="textbox"][data-slate-editor="true"], [role="textbox"][contenteditable="true"]',
        composerScopeSelector: 'form, [class*="channelTextArea"], [role="dialog"], main',
        actionSelector: 'button[type="submit"], button[aria-label*="Send" i], button[aria-label*="发送"], [class*="buttons_"] button',
        placement: 'before',
        plainTextOutput: false,
        contextRootSelector: '[role="dialog"], main',
        titleSelector: 'h1, [class*="title_"] h2, [role="heading"]',
        titleLabel: '频道主题',
        subjectInputSelector: '',
        snippetSelector: '[id^="message-content-"], [class*="messageContent_"]',
        sectionLabel: '当前消息',
        authorContainerSelector: 'li[id^="chat-messages-"], [role="article"]',
        authorSelector: '[class*="username_"], h3 span[role="button"]',
    },
    notion: {
        site: 'notion',
        editorSelector: '[contenteditable="true"][role="textbox"]',
        richEditorSelector: '[contenteditable="true"][role="textbox"]',
        composerScopeSelector: '.notion-page-discussion, [role="dialog"], form, main',
        actionSelector: '[role="button"][aria-label*="Send" i], [role="button"][aria-label*="发送"], [role="button"][aria-label*="Comment" i], [role="button"][aria-label*="评论"], button[type="submit"]',
        placement: 'before',
        plainTextOutput: false,
        contextRootSelector: '.notion-page-discussion, [role="dialog"], main',
        titleSelector: '.notion-page-block h1, h1[placeholder], [data-block-id] h1',
        titleLabel: '页面标题',
        subjectInputSelector: '',
        snippetSelector: '.notion-page-discussion [data-content-editable-leaf], [data-block-id] [data-content-editable-leaf], main p',
        sectionLabel: '当前页面',
        authorContainerSelector: '',
        authorSelector: '',
    },
};

export function matchFirstClassWritingSite(url: string): FirstClassWritingSite | null {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return null;
        return Object.hasOwn(HOST_TO_SITE, parsed.hostname) ? HOST_TO_SITE[parsed.hostname] : null;
    } catch { return null; }
}

export function getWritingSiteProfile(site: WritingSite): WritingSiteProfile | null {
    if (!site || site === 'generic') return null;
    return WRITING_SITE_PROFILES[site];
}

export function isPlainTextWritingSite(site: WritingSite | undefined): boolean {
    if (!site || site === 'generic') return true;
    return WRITING_SITE_PROFILES[site].plainTextOutput;
}
