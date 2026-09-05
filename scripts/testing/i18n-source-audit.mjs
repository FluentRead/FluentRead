/**
 * 扫描扩展 UI 的静态文案，供 i18n 契约测试复用。
 * Vue 模板、绑定表达式与 script setup 均使用语法树；忽略注释和用户内容。
 * 配置注册表仍保留中文数据，检查其在 UI 边界的精确本地化结果。
 */
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const {parse} = require(require.resolve('@vue/compiler-sfc', {paths: [path.dirname(require.resolve('vue/package.json'))]}));
const {parse: parseTemplate} = require(require.resolve('@vue/compiler-dom', {paths: [path.dirname(require.resolve('vue/package.json'))]}));

export function collectUiSourceCopy(root) {
    const sources = new Map();
    const files = [];
    function add(value, file) {
        const source = value.trim().replace(/\s+/gu, ' ');
        if (!/[\u3400-\u9fff]/u.test(source) || source.startsWith('[FluentRead]')) return;
        const locations = sources.get(source) || new Set();
        locations.add(path.relative(root, file));
        sources.set(source, locations);
    }
    function script(source, file) {
        const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
        function visit(node) {
            if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node.text, file);
            ts.forEachChild(node, visit);
        }
        visit(ast);
    }
    function template(node, file) {
        if (node.type === 1 && node.props.some(prop => prop.type === 6 && prop.name === 'data-i18n-ignore')) return;
        if (node.type === 2) add(node.content, file);
        if (node.type === 4) script(`(${node.content})`, file);
        if (node.type === 6 && ['label', 'description', 'title', 'aria-label', 'aria-description', 'placeholder', 'content', 'alt'].includes(node.name) && node.value) add(node.value.content, file);
        if (node.content && typeof node.content === 'object') template(node.content, file);
        if (node.exp) template(node.exp, file);
        for (const child of node.children || []) template(child, file);
        for (const prop of node.props || []) template(prop, file);
    }
    function walk(directory) {
        for (const item of fs.readdirSync(directory, {withFileTypes: true})) {
            const file = path.join(directory, item.name);
            if (item.isDirectory()) walk(file);
            else if (item.name.endsWith('.vue')) {
                files.push(path.relative(root, file));
                const {descriptor, errors} = parse(fs.readFileSync(file, 'utf8'));
                if (errors.length) throw new Error(`${file}: ${errors.join(', ')}`);
                if (descriptor.template) template(parseTemplate(descriptor.template.content), file);
                for (const block of [descriptor.script, descriptor.scriptSetup]) if (block) script(block.content, file);
            }
        }
    }
    walk(path.join(root, 'src'));
    for (const relative of [
        'src/features/settings/model/navigation.ts',
        'src/features/document-translation/ui/presentation.ts',
        'src/core/config/interfaceAppearance.ts',
        'src/core/config/translationLoadingStyle.ts',
        'src/core/config/videoSubtitleAppearance.ts',
        'src/core/config/harness.ts',
        'src/core/config/diff.ts',
        'src/features/image-translation/content/controls.ts',
        'src/features/video-subtitle/transcription.ts',
    ]) {
        files.push(relative);
        script(fs.readFileSync(path.join(root, relative), 'utf8'), path.join(root, relative));
    }
    return {files, sources: [...sources].map(([source, locations]) => ({source, files: [...locations]}))};
}
