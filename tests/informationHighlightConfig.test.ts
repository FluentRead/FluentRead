import {describe, expect, it} from 'vitest';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {DEFAULT_INFORMATION_HIGHLIGHT_PREFERENCES, normalizeInformationHighlightPreferences} from '@/src/core/config/informationHighlight';

describe('信息高亮偏好与配置迁移', () => {
    it('旧配置和非法字段获得独立默认值，自动高亮和快捷键默认关闭', () => {
        for (const value of [undefined, null, [], false, '', {mode:'cloud',density:NaN,color:'red',style:'bold'}]) {
            expect(normalizeInformationHighlightPreferences(value)).toEqual(DEFAULT_INFORMATION_HIGHLIGHT_PREFERENCES);
            expect(normalizeConfig({informationHighlight:value}).informationHighlight).toEqual(DEFAULT_INFORMATION_HIGHLIGHT_PREFERENCES);
        }
        const first=new Config(); const second=new Config();
        first.informationHighlight.color='blue';
        expect(second.informationHighlight.color).toBe('rose');
        expect(second.informationHighlight.enabled).toBe(false);
        expect(second.informationHighlight.hotkeyEnabled).toBe(false);
    });
    it('合法设置可往返，源对象不被改写，未知字段被移除', () => {
        for (const model of ['qwen2.5-0.5b'] as const) for (const mode of ['keywords','surprisal-local'] as const) for (const density of ['low','medium','high'] as const)
            for (const color of ['rose','amber','mint','blue','violet','slate'] as const) for (const style of ['heatmap','background','underline'] as const) {
                const preferences={enabled:style!=='underline',hotkey:mode==='keywords'?'Alt+H':'',hotkeyEnabled:density!=='low',mode,model,density,color,style,intensity:(['soft','standard','strong'] as const)[density.length%3]};
                const source={informationHighlight:{...preferences,session:true}};
                const normalized=normalizeConfig(source);
                expect(normalized.informationHighlight).toEqual(preferences);
                expect(normalizeConfig(JSON.parse(JSON.stringify(normalized))).informationHighlight).toEqual(preferences);
                expect(source.informationHighlight.session).toBe(true);
            }
    });
    it('旧版完整外观保持原值，缺失字段采用柔和热力默认，开关只接受明确的 true', () => {
        const old = {mode: 'surprisal-local', density: 'low', color: 'amber', style: 'background'};
        expect(normalizeInformationHighlightPreferences(old)).toEqual({enabled: false, hotkey: 'Alt+H', hotkeyEnabled: false, ...old, model: 'qwen2.5-0.5b', intensity: 'standard'});
        for (const intensity of ['soft', 'strong'] as const) expect(normalizeInformationHighlightPreferences({...old, intensity}).intensity).toBe(intensity);
        expect(normalizeInformationHighlightPreferences({...old, intensity: 'max'}).intensity).toBe('standard');
        for (const enabled of ['true', 1, {}, null]) expect(normalizeInformationHighlightPreferences({...old, enabled}).enabled).toBe(false);
        expect(normalizeInformationHighlightPreferences({...old, enabled: true}).enabled).toBe(true);
        for (const clickToTranslate of [false, 'true', 1, {}, null, undefined]) expect(normalizeInformationHighlightPreferences({...old, clickToTranslate})).not.toHaveProperty('clickToTranslate');
        expect(normalizeInformationHighlightPreferences({...old, clickToTranslate: true}).clickToTranslate).toBe(true);
        expect(normalizeInformationHighlightPreferences({...old, hotkey: 'option + shift + j'}).hotkey).toBe('Alt+Shift+J');
        expect(normalizeInformationHighlightPreferences({...old, hotkey: ''}).hotkey).toBe('');
        expect(normalizeInformationHighlightPreferences({...old, hotkeyEnabled: false}).hotkeyEnabled).toBe(false);
        for (const hotkeyEnabled of [0, 1, 'true', 'no', {}, [], null, undefined]) expect(normalizeInformationHighlightPreferences({...old, hotkeyEnabled}).hotkeyEnabled).toBe(false);
        expect(normalizeInformationHighlightPreferences({...old, hotkeyEnabled: true}).hotkeyEnabled).toBe(true);
        for (const hotkey of ['not a key', 7, null]) expect(normalizeInformationHighlightPreferences({...old, hotkey}).hotkey).toBe('Alt+H');
        expect(normalizeInformationHighlightPreferences({color: 'blue', style: 'underline', intensity: 'standard'})).toEqual({enabled: false, hotkey: 'Alt+H', hotkeyEnabled: false, mode: 'keywords', model: 'qwen2.5-0.5b', density: 'high', color: 'blue', style: 'underline', intensity: 'standard'});
        expect(normalizeInformationHighlightPreferences({})).toEqual({enabled: false, hotkey: 'Alt+H', hotkeyEnabled: false, mode: 'keywords', model: 'qwen2.5-0.5b', density: 'high', color: 'rose', style: 'heatmap', intensity: 'standard'});
        expect(DEFAULT_INFORMATION_HIGHLIGHT_PREFERENCES).toEqual({enabled: false, hotkey: 'Alt+H', hotkeyEnabled: false, mode: 'keywords', model: 'qwen2.5-0.5b', density: 'high', color: 'rose', style: 'heatmap', intensity: 'standard'});
    });
    it('migrates retired Qwen3 preferences to Base without changing mode, appearance or shortcut consent', () => {
        for (const model of [undefined, null, false, 3, '', 'qwen3', 'remote-provider']) {
            expect(normalizeInformationHighlightPreferences({mode: 'surprisal-local', model})).toMatchObject({mode: 'surprisal-local', model: 'qwen2.5-0.5b'});
        }
        for (const mode of ['keywords', 'surprisal-local'] as const) {
            const source = {...DEFAULT_INFORMATION_HIGHLIGHT_PREFERENCES, enabled: true, hotkey: 'Alt+J', hotkeyEnabled: true, mode, model: 'qwen3-0.6b', color: 'mint', density: 'low', intensity: 'strong'};
            const expected = {...source, model: 'qwen2.5-0.5b'};
            expect(normalizeInformationHighlightPreferences(source)).toEqual(expected);
            const config = normalizeConfig({informationHighlight: source});
            expect(config.informationHighlight).toEqual(expected);
            expect(normalizeConfig(JSON.parse(JSON.stringify(config))).informationHighlight).toEqual(expected);
            expect(source.model).toBe('qwen3-0.6b');
        }
    });
});
