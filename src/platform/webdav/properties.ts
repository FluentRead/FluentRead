/**
 * @file src/platform/webdav/properties.ts
 * 文件职责：解析有界的 WebDAV Depth:0 属性响应，按实际 XML 命名空间和目标资源提取目录能力及文件版本。
 * 主要内容：先校验绝对目标 URL，再解析命名空间、字符引用与 CDATA；同源资源兼容路径编码和目录尾斜杠差异，仍拒绝异源或歧义资源、外部实体、异常层级和非成功属性。
 * 模块边界：只处理 XML 与固定目标 URL，不发起请求、不跟随 href，不读取配置或连接凭据。
 */
import {SaxesParser} from 'saxes';
import {strongCloudEtag} from '@/src/core/config/cloudSync';

interface Element {name: string; uri: string; text: string; children: Element[]}
const children = (element: Element, name: string) => element.children.filter(child => child.uri === 'DAV:' && child.name === name);
function scalar(element: Element, name: string): string | undefined {
    const matches = children(element, name);
    return matches.length === 1 && !matches[0].children.length ? matches[0].text.trim() : undefined;
}
function matchesResource(href: string | undefined, target: URL, collection: boolean): boolean {
    if (!href || !/^(?:https?:\/\/|\/(?!\/))/iu.test(href) || /[\\\x00-\x1f\x7f]/u.test(href)) return false;
    try {
        const actual = new URL(href, target);
        if (actual.origin !== target.origin || actual.username || actual.password || actual.search || actual.hash) return false;
        const path = (url: URL) => {
            if (/%(?:2f|5c|00|0a|0d)/iu.test(url.pathname)) throw new Error('Ambiguous resource path');
            const decoded = decodeURIComponent(url.pathname);
            return collection && target.pathname.endsWith('/') ? decoded.replace(/\/$/u, '') : decoded;
        };
        return path(actual) === path(target);
    } catch {return false;}
}
export function parseWebDavProperties(xml: string, url: string): {collection: boolean; etag?: string} | undefined {
    if (xml.length > 128 * 1024) return undefined;
    let root: Element | undefined;
    let count = 0;
    const stack: Element[] = [];
    let target: URL;
    try {
        target = new URL(url);
        const parser = new SaxesParser({xmlns: true});
        parser.on('error', error => {throw error;});
        parser.on('doctype', () => {throw new Error('DTD is unsupported');});
        parser.on('opentag', tag => {
            if (++count > 4096 || stack.length >= 64) throw new Error('XML exceeds property limits');
            const element = {name: tag.local, uri: tag.uri, text: '', children: []};
            if (stack.length) stack[stack.length - 1].children.push(element);
            else root = element;
            stack.push(element);
        });
        const appendText = (text: string) => {if (stack.length) stack[stack.length - 1].text += text;};
        parser.on('text', appendText);
        parser.on('cdata', appendText);
        parser.on('closetag', () => {stack.pop();});
        parser.write(xml).close();
    } catch {return undefined;}
    if (!root || root.uri !== 'DAV:' || root.name !== 'multistatus') return undefined;
    if (root.children.some(child => child.uri === 'DAV:' && !['response', 'responsedescription'].includes(child.name))) return undefined;
    const responses = children(root, 'response');
    if (responses.length !== 1) return undefined;
    const response = responses[0];
    const href = scalar(response, 'href');
    let collection = false;
    const etags: string[] = [];
    for (const propstat of children(response, 'propstat')) {
        const status = scalar(propstat, 'status');
        const props = children(propstat, 'prop');
        if (!status || !/^HTTP\/\d(?:\.\d)? 200(?:\s|$)/u.test(status) || props.length !== 1) continue;
        for (const type of children(props[0], 'resourcetype')) if (children(type, 'collection').length === 1) collection = true;
        for (const etag of children(props[0], 'getetag')) if (!etag.children.length) etags.push(etag.text.trim());
    }
    if (!matchesResource(href, target, collection)) return undefined;
    return {collection, ...(etags.length === 1 && strongCloudEtag(etags[0]) ? {etag: etags[0]} : {})};
}
