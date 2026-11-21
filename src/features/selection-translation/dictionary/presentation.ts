/**
 * @file src/features/selection-translation/dictionary/presentation.ts
 * 文件职责：把离线词典排版放入不执行脚本、不访问网络的独立文档。
 * 主要内容：在惰性 template 中移除主动标签、事件、表单和外部资源，只保留内嵌媒体与本地样式，并生成严格 CSP。
 * 模块边界：只操作调用方提供的文档片段；不查询来源、不授予 iframe 同源或脚本能力。
 */
export function dictionaryDocument(html: string, css: string, dark: boolean, doc: Document = document): string {
    const template = doc.createElement('template');
    template.innerHTML = html.slice(0, 524288);
    const safeData = (value: string) => /^data:(?:image\/(?:png|jpeg|gif|webp|svg\+xml)|audio\/(?:mpeg|ogg|wav)|font\/(?:woff2?));base64,[a-zA-Z0-9+/=]+$/.test(value);
    const cleanCss = (value: string) => value.replace(/@import\b[^;]*(?:;|$)/gi, '').replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (_match, _quote: string, url: string) => safeData(url) ? `url("${url}")` : 'none').replace(/<\/style/gi, '');
    for (const node of template.content.querySelectorAll('*')) {
        if (['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'BASE', 'META', 'LINK', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'SVG', 'MATH'].includes(node.tagName)) {node.remove(); continue;}
        if (node.tagName === 'STYLE') node.textContent = cleanCss(node.textContent || '');
        for (const attribute of Array.from(node.attributes)) {
            const name = attribute.name.toLowerCase();
            if (name === 'style') node.setAttribute(name, cleanCss(attribute.value));
            else if (name === 'src' && ['IMG', 'AUDIO', 'SOURCE'].includes(node.tagName) && safeData(attribute.value)) continue;
            else if (!['class', 'id', 'title', 'alt', 'lang', 'dir', 'colspan', 'rowspan', 'width', 'height', 'controls'].includes(name)) node.removeAttribute(attribute.name);
        }
    }
    const clean = doc.createElement('div');
    clean.append(template.content);
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>html{color-scheme:${dark ? 'dark' : 'light'}}body{margin:12px;font:14px/1.7 system-ui;overflow-wrap:anywhere}img{max-width:100%;height:auto}audio{max-width:100%}${cleanCss(css.slice(0, 262144))}</style></head><body>${clean.innerHTML}</body></html>`;
}
