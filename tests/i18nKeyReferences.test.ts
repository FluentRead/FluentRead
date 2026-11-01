import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {collectUiMessageReferences, auditUiMessageReferences} from '../scripts/testing/i18n-key-audit.mjs';
import {zhCNMessages} from '@/src/core/i18n/messages/zh-CN';
import {UI_LANGUAGE_OPTIONS} from '@/src/core/i18n/language';
import {UI_LANGUAGE_BUNDLES} from '@/src/core/i18n/bundles';
import {personalCorrectionMessages} from '@/src/core/i18n/messages/personalCorrections';
import {selectionDictionaryMessages} from '@/src/core/i18n/messages/selectionDictionary';

describe('稳定 i18n key 的生产调用契约', () => {
    it('真实源码的可枚举 key 均存在，字面参数完整', () => {
        const audit = collectUiMessageReferences(process.cwd());
        expect(audit.references.length).toBeGreaterThan(700);
        expect(auditUiMessageReferences(audit.references, zhCNMessages)).toEqual([]);
    });

    it('设置与个人校订的稳定资源在最终七语目录中生效，不被旧的对象展开顺序静默覆盖', () => {
        for (const {value: language} of UI_LANGUAGE_OPTIONS) {
            const final: Readonly<Record<string, string>> = language === 'zh-CN' ? zhCNMessages : UI_LANGUAGE_BUNDLES[language].messages;
            const settings = JSON.parse(readFileSync(join(process.cwd(), 'src/core/i18n/messages/settings-copy', language + '.json'), 'utf8'))
                .messages as Record<string, string>;
            expect(Object.keys(settings).length).toBeGreaterThan(100);
            for (const source of [settings, personalCorrectionMessages[language], selectionDictionaryMessages[language]]) {
                for (const [key, value] of Object.entries(source)) expect(final[key], `${language}: ${key}`).toBe(value);
            }
        }
    });

    it('按导入绑定识别别名、Vue 属性与条件 key，报告动态调用并忽略普通同名函数', () => {
        const root = mkdtempSync(join(tmpdir(), 'fluentread-i18n-key-audit-'));
        mkdirSync(join(root, 'src'));
        try {
            writeFileSync(join(root, 'src/Fixture.vue'), `<script setup lang="ts">
                import {useUiI18n as useLanguage} from '@/src/ui/i18n';
                import {translate as message} from '@/src/core/i18n/index';
                const {t: text} = useLanguage();
                const state = true, key = 'unknown.dynamic';
                message('known.count', 'en-US', {count: 2});
                message('known.count', 'en-US', {});
                text(key);
                text(\`known.\${state ? 'one' : 'two'}\`);
                // text('ignored.comment')
                const example = "text('ignored.string')";
            </script><template><button :title="text('unknown.attribute')">{{ text(state ? 'known.one' : 'known.two') }}{{ text('known.count', {count: 3}) }}</button></template>`);
            writeFileSync(join(root, 'src/Plain.ts'), `function t(key: string) {return key;} t('ignored.function');`);
            const audit = collectUiMessageReferences(root);
            expect(audit.references.flatMap(item => item.keys)).toEqual(['known.count', 'known.count', 'known.one', 'known.two', 'known.one', 'known.two', 'known.count', 'unknown.attribute']);
            expect(audit.dynamic).toEqual([{file: 'src/Fixture.vue', location: 'script', expression: 'key'}]);
            const issues = auditUiMessageReferences(audit.references, {'known.count': '{count} 项', 'known.one': '一', 'known.two': '二'});
            expect(issues).toEqual([
                'src/Fixture.vue (script): known.count — missing parameters: count',
                'src/Fixture.vue (template): unknown.attribute — unknown key',
            ]);
        } finally {rmSync(root, {recursive: true, force: true});}
    });

    it('动态参数对象交由运行态测试，继承字段不能冒充合法资源', () => {
        expect(auditUiMessageReferences([
            {file: 'fixture', location: 'script', keys: ['known'], params: undefined},
            {file: 'fixture', location: 'script', keys: ['constructor'], params: []},
        ], {known: '{count}'})).toEqual(['fixture (script): constructor — unknown key']);
    });

    it('脚本绑定遵循函数、块和 var 作用域，内层资源绑定不会泄漏，工厂同名参数不被误认', () => {
        const root = mkdtempSync(join(tmpdir(), 'fluentread-i18n-key-scope-'));
        mkdirSync(join(root, 'src'));
        try {
            writeFileSync(join(root, 'src/Fixture.ts'), `
                import {useUiI18n as useLanguage} from '@/src/ui/i18n';
                import {translate as message} from '@/src/core/i18n';
                const {t: text} = useLanguage();
                text('known.root');
                function parameter(text: (key: string) => string) {text('ignored.parameter');}
                { const text = (key: string) => key; text('ignored.block'); }
                function local() { const {'t': inner} = useLanguage(); inner('known.local'); }
                inner('ignored.leaked');
                function shadowFactory(useLanguage: () => any) {
                    const {t: ordinary} = useLanguage(); ordinary('ignored.factory');
                }
                function shadowCore(message: (key: string) => string) {message('ignored.core');}
                function hoistedVar() {
                    text('ignored.var.before');
                    if (true) {var text = (key: string) => key;}
                    text('ignored.var.after');
                }
                function outer() {message('known.core', 'en-US');}
                text('known.after');
            `);
            const audit = collectUiMessageReferences(root);
            expect(audit.references.flatMap(item => item.keys)).toEqual(['known.root', 'known.local', 'known.core', 'known.after']);
            expect(audit.dynamic).toEqual([]);
        } finally {rmSync(root, {recursive: true, force: true});}
    });

    it('Vue 循环、插槽和事件参数遮蔽资源绑定，外层指令和组件属性仍检查实际引用', () => {
        const root = mkdtempSync(join(tmpdir(), 'fluentread-i18n-key-template-scope-'));
        mkdirSync(join(root, 'src'));
        try {
            writeFileSync(join(root, 'src/Fixture.vue'), `<script setup lang="ts">
                import {useUiI18n} from '@/src/ui/i18n';
                const {t: text} = useUiI18n();
            </script><template>
                <section v-for="text in items" v-if="text('known.condition')" :title="text('ignored.loop')">{{ text('ignored.child') }}</section>
                <Widget v-slot="{text}" :title="text('known.prop')">{{ text('ignored.slot') }}</Widget>
                <button @click="(text) => text('ignored.event')" :[text('known.attribute')].attr="value">{{ text('known.after') }}</button>
                <div v-for="item in text('known.items')">{{ text('known.list') }}</div>
            </template>`);
            const audit = collectUiMessageReferences(root);
            expect(audit.references.flatMap(item => item.keys).sort()).toEqual([
                'known.condition', 'known.prop', 'known.attribute', 'known.after', 'known.items', 'known.list',
            ].sort());
            expect(audit.dynamic).toEqual([]);
        } finally {rmSync(root, {recursive: true, force: true});}
    });

    it('静态空参数和 TypeScript 包裹不能绕过缺参检查，真实动态参数仍保留运行态边界', () => {
        const root = mkdtempSync(join(tmpdir(), 'fluentread-i18n-key-params-'));
        mkdirSync(join(root, 'src'));
        try {
            writeFileSync(join(root, 'src/Fixture.ts'), `
                import {translate as text} from '@/src/core/i18n';
                text(('known' as string), 'en-US', ({} as const));
                text('known', 'en-US', undefined);
                text('known', 'en-US', null);
                text('known', 'en-US', void 0);
                text('known', 'en-US', ({count: 2} satisfies Record<string, number>));
                text('known', 'en-US', params);
                function shadow(undefined: Record<string, number>) {text('known', 'en-US', undefined);}
            `);
            const audit = collectUiMessageReferences(root);
            expect(auditUiMessageReferences(audit.references, {known: '{count}'})).toHaveLength(4);
            expect(audit.references.map(item => item.params)).toEqual([[], [], [], [], ['count'], undefined, undefined]);
        } finally {rmSync(root, {recursive: true, force: true});}
    });
});
