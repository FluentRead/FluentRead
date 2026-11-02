/**
 * @file src/ui/confirmExport.ts
 * 文件职责：为自有页面提供带可选内容的导出确认，确认按钮始终执行导出，取消和关闭始终放弃。
 * 主要内容：每次打开创建默认关闭的本地复选框，返回本次确认的选择；提供标题、说明和可选补充说明，不跨弹窗保留选择。
 * 模块边界：只使用 Vue 展示节点和 Element Plus 确认框，不读取配置、不下载文件、不拥有业务或页面生命周期；调用者在确认后继续复核操作归属。
 */
import {h} from 'vue';
import {ElMessageBox} from 'element-plus';

export async function confirmExport(options: {title: string; description: string; option: string; optionDescription?: string; cancel: string}): Promise<boolean | null> {
  let included = false;
  try {
    await ElMessageBox.confirm(h('div', {class: 'fr-backup-export-options'}, [
      h('p', options.description),
      h('label', {class: 'fr-backup-export-option'}, [
        h('input', {type: 'checkbox', checked: false, onChange(event: Event) {included = (event.target as HTMLInputElement).checked;}}),
        h('span', [h('strong', options.option), ...(options.optionDescription ? [h('small', options.optionDescription)] : [])]),
      ]),
    ]), options.title, {confirmButtonText: options.title, cancelButtonText: options.cancel, customClass: 'fr-backup-export-dialog', closeOnClickModal: false});
    return included;
  } catch {return null;}
}
