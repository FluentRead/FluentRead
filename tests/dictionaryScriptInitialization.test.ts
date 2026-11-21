import {expect,it,vi} from 'vitest';
it('releases failed VM initialization so the next explicit lookup can retry',async()=>{
    const actual=await import('quickjs-emscripten-core');
    const create=vi.fn(actual.newQuickJSWASMModuleFromVariant).mockRejectedValueOnce(new Error('fixture engine load failed'));
    vi.doMock('quickjs-emscripten-core',()=>({...actual,newQuickJSWASMModuleFromVariant:create}));
    try {
        const {runDictionaryScript}=await import('@/src/features/selection-translation/dictionary/script');
        await expect(runDictionaryScript('return 1;','word',{})).rejects.toThrow('fixture engine load failed');
        expect(await runDictionaryScript('return 2;','word',{})).toBe(2);expect(create).toHaveBeenCalledTimes(2);
    }finally{vi.doUnmock('quickjs-emscripten-core');}
});
