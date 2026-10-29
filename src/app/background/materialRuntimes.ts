/**
 * @file src/app/background/materialRuntimes.ts
 * 文件职责：装配材料导入、分页读取与备份导出的后台端口运行时。
 * 主要内容：将同一配置就绪信号传给各端口安装器，使三个入口使用一致的启动依赖和各自的生命周期保护。
 * 模块边界：只负责后台组合，不创建数据库、不处理材料正文、权限校验或消息传输，具体清理行为由各运行时负责。
 */
import {installBrowserMaterialImportRuntime} from './materialImportRuntime';
import {installBrowserMaterialPageRuntime} from './materialPageRuntime';
import {installBrowserMaterialBackupExportRuntime} from './materialBackupExportRuntime';

export function installMaterialRuntimes(ready:Promise<unknown>):void {
    installBrowserMaterialImportRuntime(ready);
    installBrowserMaterialPageRuntime(ready);
    installBrowserMaterialBackupExportRuntime(ready);
}
