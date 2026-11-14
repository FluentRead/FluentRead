/**
 * @file src/core/privacy/detect.ts
 * 文件职责：在本地识别文本中的结构化个人信息、凭据及用户指定的字面敏感词。
 * 主要内容：有界规则、卡号/身份证/IBAN 校验、带标签的密码与验证码识别，以及自定义词的 Aho-Corasick 单遍匹配；重叠区间取并集以避免部分泄漏。
 * 模块边界：不调用 NER 或云服务，不保存匹配文本，不接受用户正则；自由文本姓名/地址须用自定义词补充，不能把规则检测解释为完全识别。
 */
import {MAX_PRIVACY_MATCHES, MAX_PRIVACY_TEXT_LENGTH, normalizePrivacyTerms, PrivacyProtectionError,
    type PrivacyCategory, type PrivacyProtectionPolicy} from './policy';

export interface PrivacySpan {start: number; end: number; category: PrivacyCategory | 'custom'}
interface Rule {category: PrivacyCategory; pattern: RegExp; validate?: (value: string) => boolean}

function luhn(value: string): boolean {
    const digits = value.replace(/\D/gu, '');
    if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/u.test(digits)) return false;
    // 信用卡号需要常见发卡前缀；不能把恰好通过校验的年份/普通编号串当作卡号。
    if (!/^[3-6]/u.test(digits) && !(digits.length === 16 && Number(digits.slice(0, 4)) >= 2221 && Number(digits.slice(0, 4)) <= 2720)) return false;
    let sum = 0;
    for (let index = digits.length - 1, alternate = false; index >= 0; index--, alternate = !alternate) {
        let digit = Number(digits[index]);
        if (alternate) {digit *= 2; if (digit > 9) digit -= 9;}
        sum += digit;
    }
    return sum % 10 === 0;
}

function chineseIdentity(value: string): boolean {
    const year = Number(value.slice(6, 10)), month = Number(value.slice(10, 12)), day = Number(value.slice(12, 14));
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
    const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    return '10X98765432'[weights.reduce((sum, weight, index) => sum + weight * Number(value[index]), 0) % 11] === value[17].toUpperCase();
}

function iban(value: string): boolean {
    const compact = value.replace(/ /gu, '').toUpperCase();
    // 调用规则已将紧凑长度限定为 15–34 字符。
    let remainder = 0;
    for (const char of compact.slice(4) + compact.slice(0, 4)) {
        for (const digit of /[A-Z]/u.test(char) ? String(char.charCodeAt(0) - 55) : char) remainder = (remainder * 10 + Number(digit)) % 97;
    }
    return remainder === 1;
}

// 固定、预编译且带长度界限的表达式；每次扫描重置 lastIndex，同步运行不会跨请求共享游标。
const rules: readonly Rule[] = [
    {category: 'email', pattern: /(?<![\p{L}\p{N}._%+\-])(?<value>[\p{L}\p{N}._%+\-]{1,64}@[\p{L}\p{N}\-]{1,63}(?:\.[\p{L}\p{N}\-]{1,63}){1,8})(?![\p{L}\p{N}_\-])/gu},
    {category: 'phone', pattern: /(?<!\d)(?<value>(?:\+?86[ -]?)?1[3-9]\d{9})(?!\d)/gu},
    {category: 'phone', pattern: /(?<![\w+])(?<value>\+\d(?:[ ()-]?\d){7,14})(?!\d)/gu},
    {category: 'phone', pattern: /(?<!\d)(?<value>\(?[2-9]\d{2}\)?[- .][2-9]\d{2}[- .]\d{4})(?!\d)/gu},
    {category: 'phone', pattern: /(?:电话|手机|phone|tel)\s*[:：=]\s*(?<value>\+?\d[\d ()-]{5,24}\d)/giu},
    {category: 'identity', pattern: /(?<!\d)(?<value>[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx])(?!\d)/gu, validate: chineseIdentity},
    {category: 'identity', pattern: /(?<!\d)(?<value>(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4})(?!\d)/gu},
    {category: 'identity', pattern: /(?:身份证(?:号)?|护照(?:号)?|passport|national[ _-]?id)\s*[:：=]\s*(?<value>[A-Z0-9]{5,20})/giu},
    {category: 'payment', pattern: /(?<!\d)(?<value>\d(?:[ -]?\d){12,18})(?![ -]?\d)/gu, validate: luhn},
    {category: 'payment', pattern: /\b(?<value>[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30})\b/gu, validate: iban},
    {category: 'payment', pattern: /(?:银行卡(?:号)?|银行账号|bank[ _-]?account|card[ _-]?(?:number|no))\s*[:：=]\s*(?<value>\d[\d -]{6,28}\d)/giu},
    {category: 'secret', pattern: /(?:password|passwd|pwd|api[ _-]?key|(?:access[ _-]?|refresh[ _-]?auth[ _-]?)token|secret|密码|口令|密钥|令牌|验证码|verification[ _-]?code|otp)["']?\s*[:：=]\s*(?:"(?<quoted>[^"\r\n]{1,1024})"|'(?<single>[^'\r\n]{1,1024})'|(?<value>[^\s"',;，；<>]{1,1024}))/giu},
    {category: 'secret', pattern: /\b(?<value>(?:sk-(?:proj-|ant-)?|gh[pousr]_|github_pat_|xox[baprs]-)[A-Za-z0-9_\-]{16,256})\b/gu},
    {category: 'secret', pattern: /\b(?<value>(?:AKIA|ASIA)[A-Z0-9]{16})\b/gu},
    {category: 'secret', pattern: /\bBearer\s+(?<value>[A-Za-z0-9._~+\/-]{8,2048}=*)/giu},
    {category: 'secret', pattern: /\b(?<value>eyJ[A-Za-z0-9_\-]{4,2048}\.[A-Za-z0-9_\-]{4,4096}\.[A-Za-z0-9_\-]{4,1024})\b/gu},
    {category: 'secret', pattern: /(?:助记词|seed[ _-]?phrase|mnemonic)\s*[:：=]\s*(?<value>[a-z]{2,16}(?: [a-z]{2,16}){11,23})\b/giu},
    {category: 'network', pattern: /(?<![\d.])(?<value>\d{1,3}(?:\.\d{1,3}){3})(?!\d|\.\d)/gu, validate: value => value.split('.').every(part => Number(part) <= 255)},
];

interface TrieNode {next: Map<string, number>; fail: number; longest: number}
function compileTerms(terms: readonly string[]) {
    const nodes: TrieNode[] = [{next: new Map(), fail: 0, longest: 0}];
    for (const term of terms) {
        let state = 0;
        // 与 JS 字符串偏移一致，按 UTF-16 单元建立自动机，保留 emoji 的完整词条长度。
        for (let index = 0; index < term.length; index++) {
            const char = term[index];
            let next = nodes[state].next.get(char);
            if (next === undefined) {next = nodes.length; nodes[state].next.set(char, next); nodes.push({next: new Map(), fail: 0, longest: 0});}
            state = next;
        }
        nodes[state].longest = term.length;
    }
    const queue = [...nodes[0].next.values()];
    for (let head = 0; head < queue.length; head++) {
        const state = queue[head];
        for (const [char, child] of nodes[state].next) {
            let failure = nodes[state].fail;
            while (failure && !nodes[failure].next.has(char)) failure = nodes[failure].fail;
            nodes[child].fail = nodes[failure].next.get(char) ?? 0;
            nodes[child].longest = Math.max(nodes[child].longest, nodes[nodes[child].fail].longest);
            queue.push(child);
        }
    }
    return nodes;
}

export function createPrivacyDetector(policy: PrivacyProtectionPolicy, customTerms: readonly string[] = []) {
    const selectedRules = rules.filter(rule => policy.categories.includes(rule.category));
    const terms = normalizePrivacyTerms(customTerms);
    const trie = terms.length ? compileTerms(terms) : undefined;
    return (text: string): PrivacySpan[] => {
        if (text.length > MAX_PRIVACY_TEXT_LENGTH) throw new PrivacyProtectionError('PRIVACY_CAPACITY_EXCEEDED');
        let scanned = text;
        let offsets: number[] | undefined;
        // 全角形式与常见零宽分隔符不能绕过结构化规则。自定义词仍在原文精确匹配。
        if (/[\uFF01-\uFF5E\u3000\u200B-\u200D\uFEFF]/u.test(text)) {
            offsets = [];
            const characters: string[] = [];
            for (let index = 0; index < text.length; index++) {
                const code = text.charCodeAt(index);
                if (code >= 0x200B && code <= 0x200D || code === 0xFEFF) continue;
                characters.push(code >= 0xFF01 && code <= 0xFF5E ? String.fromCharCode(code - 0xFEE0) : code === 0x3000 ? ' ' : text[index]);
                offsets.push(index);
            }
            scanned = characters.join('');
        }
        const spans: PrivacySpan[] = [];
        const add = (start: number, end: number, category: PrivacySpan['category']) => {
            if (spans.length >= MAX_PRIVACY_MATCHES) throw new PrivacyProtectionError('PRIVACY_CAPACITY_EXCEEDED');
            spans.push({start, end, category});
        };
        const addScanned = (start: number, end: number, category: PrivacySpan['category']) =>
            add(offsets ? offsets[start] : start, offsets ? offsets[end - 1] + 1 : end, category);
        for (const rule of selectedRules) {
            rule.pattern.lastIndex = 0;
            for (const match of scanned.matchAll(rule.pattern)) {
                const value = match.groups!.value ?? match.groups!.quoted ?? match.groups!.single;
                if (rule.validate && !rule.validate(value)) continue;
                const start = match.index + match[0].lastIndexOf(value);
                addScanned(start, start + value.length, rule.category);
            }
        }
        if (policy.categories.includes('secret')) {
            const begin = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/gu;
            for (let match = begin.exec(scanned); match; match = begin.exec(scanned)) {
                const ending = match[0].replace('BEGIN', 'END');
                const end = scanned.indexOf(ending, begin.lastIndex);
                const stop = end < 0 ? scanned.length : end + ending.length;
                addScanned(match.index, stop, 'secret');
                begin.lastIndex = stop;
            }
        }
        if (trie) {
            let state = 0;
            for (let index = 0; index < text.length; index++) {
                const char = text[index];
                while (state && !trie[state].next.has(char)) state = trie[state].fail;
                state = trie[state].next.get(char) ?? 0;
                const length = trie[state].longest;
                if (length) add(index + 1 - length, index + 1, 'custom');
            }
        }
        spans.sort((a, b) => a.start - b.start || b.end - a.end);
        const merged: PrivacySpan[] = [];
        for (const span of spans) {
            const previous = merged.at(-1);
            if (previous && span.start < previous.end) previous.end = Math.max(previous.end, span.end);
            else merged.push({...span});
        }
        return merged;
    };
}
