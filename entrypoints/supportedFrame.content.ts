/**
 * @file entrypoints/supportedFrame.content.ts
 * 文件职责：在旧 QQ 邮件阅读页、Disqus 评论、Kaggle 笔记本、Hugging Face Spaces 正文及 edX 课程共用受限子 frame 入口。
 * 主要内容：合并注入条件相同的内容脚本，由各运行时再次核验页面与顶层来源。
 * 模块边界：网易邮箱需匹配 about:blank 子 frame，仍使用独立入口；通用内容入口仍只在顶层运行。
 */
import {startEmbeddedFrameApp} from '@/src/app/content/embeddedFrameRuntime';
import {startQqMailFrameApp} from '@/src/app/content/qqMailFrameRuntime';
import {startCourseCaptionFrameApp} from '@/src/app/content/courseCaptionFrame';

export default defineContentScript({
    matches: [
        'https://*.hf.space/*',
        'https://disqus.com/embed/comments/*',
        'https://www.kaggleusercontent.com/kf/*/__results__.html*',
        'https://mail.qq.com/cgi-bin/readmail*',
        'https://courses.edx.org/*',
    ],
    allFrames: true,
    runAt: 'document_end',
    cssInjectionMode: 'ui',
    main: ctx => window.location.hostname === 'courses.edx.org' ? startCourseCaptionFrameApp(ctx) : window.location.hostname === 'mail.qq.com'
        ? startQqMailFrameApp(ctx) : startEmbeddedFrameApp(ctx),
});
