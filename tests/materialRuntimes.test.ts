import {expect,it,vi} from 'vitest';
import {installMaterialRuntimes} from '@/src/app/background/materialRuntimes';

const mocks=vi.hoisted(()=>({importRuntime:vi.fn(),pageRuntime:vi.fn(),exportRuntime:vi.fn()}));
vi.mock('@/src/app/background/materialImportRuntime',()=>({installBrowserMaterialImportRuntime:mocks.importRuntime}));
vi.mock('@/src/app/background/materialPageRuntime',()=>({installBrowserMaterialPageRuntime:mocks.pageRuntime}));
vi.mock('@/src/app/background/materialBackupExportRuntime',()=>({installBrowserMaterialBackupExportRuntime:mocks.exportRuntime}));

it('installs all material port runtimes with the same readiness dependency',()=>{
    const ready=Promise.resolve();
    installMaterialRuntimes(ready);
    for(const install of Object.values(mocks)){expect(install).toHaveBeenCalledOnce();expect(install).toHaveBeenCalledWith(ready);}
});
