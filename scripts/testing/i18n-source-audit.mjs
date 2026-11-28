/**
 * 扫描扩展 UI 的静态文案，供 i18n 契约测试复用。
 * Vue 模板、绑定表达式与 script setup 均使用语法树；忽略注释和用户内容。
 * 模板文本按 Vue 运行时的文本节点合成：相邻文本与插值拼成整句，插值以数字占位。
 * 配置注册表仍保留中文数据，检查其在 UI 边界的精确本地化结果。
 * 可信类型约束下的完整只读七语表逐分支校验，其余中文继续按原契约检查。
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
        const locales = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES'];
        const nonChineseLocales = new Set(['en-US', 'ko-KR', 'fr-FR', 'ru-RU', 'es-ES']);
        const typeModules = new Set(['src/core/i18n', 'src/core/i18n/language', 'src/core/i18n/types'].map(value => path.resolve(root, value)));
        const languageTypes = new Set();
        const blockedTypes = new Set();
        // 只认可当前公共类型的真实 named import；同一顶层作用域的重名声明保守回到普通扫描。
        for (const statement of ast.statements) {
            if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
                const value = statement.moduleSpecifier.text;
                const modulePath = value.startsWith('@/') ? path.resolve(root, value.slice(2))
                    : value.startsWith('.') ? path.resolve(path.dirname(file), value) : undefined;
                const canonical = modulePath && typeModules.has(modulePath.replace(/\.ts$/u, ''));
                const clause = statement.importClause;
                if (clause?.name) blockedTypes.add(clause.name.text);
                if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                    for (const item of clause.namedBindings.elements) {
                        if (canonical && (item.propertyName?.text ?? item.name.text) === 'UiLanguage') {
                            if (languageTypes.has(item.name.text)) blockedTypes.add(item.name.text);
                            languageTypes.add(item.name.text);
                            if (item.name.text === 'Record' || item.name.text === 'Readonly') blockedTypes.add(item.name.text);
                        } else blockedTypes.add(item.name.text);
                    }
                } else if (clause?.namedBindings) blockedTypes.add(clause.namedBindings.name.text);
            } else if ((ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)
                || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement))
                && statement.name && ts.isIdentifier(statement.name)) blockedTypes.add(statement.name.text);
        }
        function recordType(node) {
            if (!node || !ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName)) return undefined;
            const name = node.typeName.text;
            if (blockedTypes.has(name)) return undefined;
            if (name === 'Readonly' && node.typeArguments?.length === 1) {
                const inner = recordType(node.typeArguments[0]);
                return inner && {...inner, readonly: true};
            }
            if (name !== 'Record' || node.typeArguments?.length !== 2) return undefined;
            const [language, value] = node.typeArguments;
            if (!ts.isTypeReferenceNode(language) || !ts.isIdentifier(language.typeName) || language.typeArguments?.length
                || !languageTypes.has(language.typeName.text) || blockedTypes.has(language.typeName.text)
                || value.kind !== ts.SyntaxKind.StringKeyword) return undefined;
            return {readonly: false};
        }
        function localizedTable(node) {
            if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer
                || (node.parent.flags & ts.NodeFlags.BlockScoped) !== ts.NodeFlags.Const || !ts.isVariableStatement(node.parent.parent)
                || node.parent.parent.parent !== ast) return false;
            const annotation = recordType(node.type);
            if (node.type && !annotation?.readonly) return false;
            let expression = node.initializer, constant = false, checked = false;
            while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
                if (ts.isAsExpression(expression)) {
                    if (!ts.isTypeReferenceNode(expression.type) || !ts.isIdentifier(expression.type.typeName)
                        || expression.type.typeName.text !== 'const' || expression.type.typeArguments?.length) return false;
                    constant = true;
                } else if (ts.isSatisfiesExpression(expression)) {
                    if (!recordType(expression.type)) return false;
                    checked = true;
                }
                expression = expression.expression;
            }
            // satisfies 本身不冻结推断类型；可变 Record 标注也不能借 as const 作为只读表。
            if ((!annotation?.readonly && !(constant && checked)) || !ts.isObjectLiteralExpression(expression)
                || expression.properties.length !== locales.length) return false;
            const seen = new Set();
            for (const property of expression.properties) {
                if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name)
                    || (!ts.isStringLiteral(property.initializer) && !ts.isNoSubstitutionTemplateLiteral(property.initializer))) return false;
                const locale = property.name.text, value = property.initializer.text;
                if (!locales.includes(locale) || seen.has(locale) || !value.trim()
                    || (nonChineseLocales.has(locale) && /[\u3400-\u9fff]/u.test(value))) return false;
                seen.add(locale);
            }
            return seen.size === locales.length;
        }
        function visit(node) {
            // 完整只读语言表直接验证每个分支；不把中文分支跨语言重新当成全局旧版文案。
            if (localizedTable(node)) return;
            if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
                // 搜索别名只用于匹配，不渲染；仍审计标签、说明与其他用户可见文案。
                const parent = node.parent;
                const isSearchAlias = parent && ts.isPropertyAssignment(parent)
                    && parent.initializer === node && parent.name.getText(ast).replace(/["']/gu, '') === 'searchTerms';
                if (!isSearchAlias) add(node.text, file);
            }
            ts.forEachChild(node, visit);
        }
        visit(ast);
    }
    // Vue 会把相邻的静态文本与插值编译成同一个文本节点，运行时 UI 指令看到的是拼接后的整句，
    // 因此这里按运行时形态合成文本，插值用数字占位，交给参数化模板校验，而不是逐段检查片段。
    const INTERPOLATION_PLACEHOLDER = '12';
    // 只由字符串字面量构成的条件插值（例如 a ? '原文' : '译文'）展开为全部取值，其余插值使用占位。
    function literalAlternatives(expression) {
        const ast = ts.createSourceFile('interpolation.ts', `(${expression})`, ts.ScriptTarget.Latest, true);
        const alternatives = (node) => {
            if (ts.isParenthesizedExpression(node)) return alternatives(node.expression);
            if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
            if (ts.isConditionalExpression(node)) {
                const whenTrue = alternatives(node.whenTrue);
                const whenFalse = alternatives(node.whenFalse);
                return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
            }
            return null;
        };
        const statement = ast.statements[0];
        return statement && ts.isExpressionStatement(statement) ? alternatives(statement.expression) : null;
    }
    function textRuns(children, file) {
        let run = [];
        const flush = () => {
            if (run.some(child => child.type === 5)) {
                let variants = [''];
                for (const child of run) {
                    const values = child.type === 2 ? [child.content] : literalAlternatives(child.content.content) || [INTERPOLATION_PLACEHOLDER];
                    variants = variants.flatMap(prefix => values.map(value => prefix + value));
                }
                for (const variant of variants) add(variant, file);
            } else for (const child of run) add(child.content, file);
            run = [];
        };
        for (const child of children) {
            if (child.type === 2 || child.type === 5) run.push(child);
            else if (child.type !== 3) flush();
        }
        flush();
    }
    function template(node, file) {
        if (node.type === 1 && node.props.some(prop => prop.type === 6 && prop.name === 'data-i18n-ignore')) return;
        if (node.type === 4) script(`(${node.content})`, file);
        if (node.type === 6 && ['label', 'description', 'title', 'aria-label', 'aria-description', 'placeholder', 'content', 'alt'].includes(node.name) && node.value) add(node.value.content, file);
        if (node.content && typeof node.content === 'object') template(node.content, file);
        if (node.exp) template(node.exp, file);
        if (node.children) textRuns(node.children, file);
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
        'src/core/config/translationAppearance.ts',
        'src/core/config/writingPreview.ts',
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
