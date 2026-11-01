/**
 * @file userscript/translationCenterPlugin.ts
 * 文件职责：在 userscript 构建时将共享翻译中心固定为设置页展示，移除不可达的原生侧栏分支。
 * 主要内容：在 Vue 编译前仅处理翻译中心原始 SFC，按模板表达式和脚本 AST 把已有 sidebar 判定替换为常量，清除可确定的模板条件；不按字符串匹配改写文案或注释中的相似字样，其它组件和虚拟子模块保持原样。
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
                function surfaceValue(node: ts.Node): boolean | undefined {
                    if (ts.isBinaryExpression(node)
                        && (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken || node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
                        && ts.isStringLiteral(node.right) && node.right.text === 'sidebar'
                        && (template ? ts.isIdentifier(node.left) && node.left.text === 'surface'
                            : ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.expression)
                                && node.left.expression.text === 'props' && node.left.name.text === 'surface')) {
                        return node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
                    }
                    return undefined;
                }
                function visit(node: ts.Node) {
                    const value = surfaceValue(ts.isConditionalExpression(node) ? node.condition : node);
                    if (value !== undefined) {
                        const replacement = ts.isConditionalExpression(node) ? (value ? node.whenTrue : node.whenFalse).getText(ast) : String(value);
                        edits.push({start: offset + node.getStart(ast) - prefix.length, end: offset + node.end - prefix.length, value: replacement});
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
            const template = parse(transformed, {filename: target}).descriptor.template;
            if (template) {
                const removals: {start: number; end: number}[] = [];
                function expression(source: string): ts.Expression {
                    const ast = ts.createSourceFile('condition.ts', `(${source})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
                    return (ast.statements[0] as ts.ExpressionStatement).expression;
                }
                // 只判断纯常量和已知左值的短路；未知左值必须保留，不能丢失其求值副作用。
                function constantBoolean(node: ts.Expression): boolean | undefined {
                    if (ts.isParenthesizedExpression(node)) return constantBoolean(node.expression);
                    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
                    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
                    if (ts.isBinaryExpression(node)) {
                        const left = constantBoolean(node.left);
                        if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
                            return left === false ? false : left === true ? constantBoolean(node.right) : undefined;
                        }
                        if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
                            return left === true ? true : left === false ? constantBoolean(node.right) : undefined;
                        }
                    }
                    return undefined;
                }
                function followingElse(children: TemplateRoot['children'], index: number): boolean {
                    for (const next of children.slice(index + 1)) {
                        if (next.type === 3 || next.type === 2 && !next.content.trim()) continue;
                        return next.type === 1 && next.props.some(prop => prop.type === 7 && (prop.name === 'else' || prop.name === 'else-if'));
                    }
                    return false;
                }
                function prune(children: TemplateRoot['children']) {
                    children.forEach((node, index) => {
                        if (node.type !== 1) return;
                        const guard = node.props.find(prop => prop.type === 7 && prop.name === 'if');
                        if (guard?.type === 7 && guard.exp) {
                            const value = constantBoolean(expression(guard.exp.loc.source));
                            if (value !== undefined && !followingElse(children, index)) {
                                removals.push(value ? {start: guard.loc.start.offset, end: guard.loc.end.offset}
                                    : {start: node.loc.start.offset, end: node.loc.end.offset});
                                if (!value) return;
                            }
                        }
                        for (const prop of node.props) {
                            if (prop.type !== 7 || prop.name !== 'bind' || prop.arg?.type !== 4 || !prop.arg.isStatic || prop.arg.content !== 'class' || !prop.exp) continue;
                            let value = expression(prop.exp.loc.source);
                            while (ts.isParenthesizedExpression(value)) value = value.expression;
                            if (ts.isObjectLiteralExpression(value) && value.properties.length === 1) {
                                const item = value.properties[0];
                                if (ts.isPropertyAssignment(item) && ts.isStringLiteral(item.name) && item.name.text === 'is-sidebar'
                                    && item.initializer.kind === ts.SyntaxKind.FalseKeyword) {
                                    removals.push({start: prop.loc.start.offset, end: prop.loc.end.offset});
                                }
                            }
                        }
                        prune(node.children);
                    });
                }
                prune(template.ast!.children);
                for (const edit of removals.sort((left, right) => right.start - left.start)) {
                    transformed = transformed.slice(0, edit.start) + transformed.slice(edit.end);
                }
            }
            return {code: transformed, map: null};
        },
    };
}
