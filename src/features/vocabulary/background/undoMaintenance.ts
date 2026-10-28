/**
 * @file src/features/vocabulary/background/undoMaintenance.ts
 * 文件职责：在扩展后台启动与周期 alarm 唤醒时清除过期的词书撤销记录。
 * 主要内容：注册独立的六小时 alarm，串行启动清理，记录无正文的固定失败提示；过期后的恢复拒绝由仓库事务另行保证。
 * 模块边界：不读取快照内容、不发送页面消息，也不负责记录的过期策略或数据库事务。
 */
export const VOCABULARY_UNDO_ALARM = 'fluentread-vocabulary-undo-cleanup';

export function installVocabularyUndoMaintenance(dependencies: {
  alarms: {
    onAlarm: {addListener(listener: (alarm: {name: string}) => void): void};
    create(name: string, options: {periodInMinutes: number}): void | Promise<void>;
  };
  prune(): Promise<void>;
  warn(message: string): void;
}): void {
  const prune = () => {void Promise.resolve().then(() => dependencies.prune()).catch(() => {
    dependencies.warn('[FluentRead] 词书撤销记录清理失败');
  });};
  dependencies.alarms.onAlarm.addListener(alarm => {if (alarm.name === VOCABULARY_UNDO_ALARM) prune();});
  prune();
  void Promise.resolve().then(() => dependencies.alarms.create(VOCABULARY_UNDO_ALARM, {periodInMinutes: 360})).catch(() => {
    dependencies.warn('[FluentRead] 词书撤销清理计划创建失败');
  });
}
