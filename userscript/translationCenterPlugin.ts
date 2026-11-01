/**
 * @file userscript/translationCenterPlugin.ts
 * 文件职责：在 userscript 构建时将共享翻译中心固定为设置页展示，移除不可达的原生侧栏分支。
 * 主要内容：在 Vue 编译前仅处理翻译中心原始 SFC，按模板表达式和脚本 AST 把已有 sidebar 判定替换为常量；字符串、注释、其它组件和虚拟子模块保持原样。
 * 模块边界：只做目标平台的展示裁剪，不改变服务选择、翻译会话或扩展构建，不调整任何体积阈值。
 */
import {resolve} from 'node:path';
import {parse} from 'vue/compiler-sfc';
import ts from 'typescript';
import {normalizePath, type Plugin} from 'vite';

export function createUserscriptTranslationCenterPlugin(root: string): Plugin {
    const target = normalizePath(resolve(root, 'src/features/translation-center/ui/TranslationCenter.vue'));
    return {
        name: 'userscript-translation-center-surface', enforce: 'pre',
        transform(code, id) {
            if (normalizePath(id.replaceAll('\\', '/')) !== target) return null;
            const {descriptor, errors} = parse(code, {filename: target});
            if (errors.length) throw new Error('Userscript translation center SFC is invalid');
            const edits: {start: number; end: number; value: string}[] = [];
            function collect(source: string, offset: number, template: boolean) {
                const prefix = template ? '(' : '';
                const ast = ts.createSourceFile('translation-center.ts', prefix + source + (template ? ')' : ''), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
                function visit(node: ts.Node) {
                    if (ts.isBinaryExpression(node)
                        && (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
                        && ts.isStringLiteral(node.right) && node.right.text === 'sidebar'
                        && (template ? ts.isIdentifier(node.left) && node.left.text === 'surface'
                            : ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.expression)
                                && node.left.expression.text === 'props' && node.left.name.text === 'surface')) {
                        edits.push({start: offset + node.getStart(ast) - prefix.length, end: offset + node.end - prefix.length,
                            value: node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? 'false' : 'true'});
                    } else ts.forEachChild(node, visit);
                }
                visit(ast);
            }
            for (const block of [descriptor.script, descriptor.scriptSetup]) {
                if (block) collect(block.content, block.loc.start.offset, false);
            }
            // SFC AST 的位置相对完整源码；只读取指令/插值表达式，避免改写用户可见文本与注释。
            type TemplateRoot = NonNullable<NonNullable<typeof descriptor.template>['ast']>;
            function visitTemplate(node: TemplateRoot | TemplateRoot['children'][number]) {
                if (node.type === 1) {
                    for (const prop of node.props) {
                        if (prop.type === 7 && prop.exp) collect(prop.exp.loc.source, prop.exp.loc.start.offset, true);
                    }
                } else if (node.type === 5) collect(node.content.loc.source, node.content.loc.start.offset, true);
                if (node.type === 0 || node.type === 1) {
                    for (const child of node.children) visitTemplate(child);
                }
            }
            if (descriptor.template) visitTemplate(descriptor.template.ast!);
            let transformed = code;
            for (const edit of edits.sort((left, right) => right.start - left.start)) {
                transformed = transformed.slice(0, edit.start) + edit.value + transformed.slice(edit.end);
            }
            return {code: transformed, map: null};
        },
    };
}
