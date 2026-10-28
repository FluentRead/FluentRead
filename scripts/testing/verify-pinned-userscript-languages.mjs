/** Validate the published JSON baselines whose declaration files avoid costly literal inference. */
import {createHash} from 'node:crypto';
import {readFileSync, statSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import ts from 'typescript';

const expectedLanguages = ['es-ES', 'fr-FR', 'ja-JP', 'ko-KR', 'ru-RU'];

export function verifyPinnedUserscriptLanguages(root) {
    const modulePath = resolve(root, 'userscript/languageBundles.ts');
    const source = ts.createSourceFile(modulePath, readFileSync(modulePath, 'utf8'), ts.ScriptTarget.Latest, true);
    const languages = new Set();
    for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const specifier = statement.moduleSpecifier.text;
        if (!specifier.startsWith('./languages/') || !specifier.endsWith('.json')) continue;
        const match = /^\.\/languages\/([a-z]{2}-[A-Z]{2})\.([0-9a-f]{16})\.json$/u.exec(specifier);
        if (!match || languages.has(match[1])) throw new Error(`无效或重复的固定语言资源导入: ${specifier}`);
        const [, language, expected] = match;
        languages.add(language);
        const path = resolve(dirname(modulePath), specifier);
        const text = readFileSync(path, 'utf8');
        let serialized;
        try {serialized = JSON.stringify(JSON.parse(text));}
        catch {throw new Error(`固定语言资源不是有效 JSON: ${language}`);}
        const digest = createHash('sha256').update(serialized).digest('hex').slice(0, 16);
        // Git 的 core.autocrlf 可能把仓库末尾 LF 转为 CRLF；其余内容仍须保持规范 JSON。
        if (digest !== expected || (text !== `${serialized}\n` && text !== `${serialized}\r\n`)) {
            throw new Error(`固定语言资源内容或摘要不匹配: ${language}`);
        }
        // A missing declaration silently restores costly JSON inference; fail with a clear diagnostic.
        if (!statSync(path.replace(/\.json$/u, '.d.json.ts')).isFile()) throw new Error(`固定语言声明不存在: ${language}`);
    }
    if ([...languages].sort().join(',') !== expectedLanguages.join(',')) throw new Error('固定语言资源列表不完整');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    verifyPinnedUserscriptLanguages(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
}
