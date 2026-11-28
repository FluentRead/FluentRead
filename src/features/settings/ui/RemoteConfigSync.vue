<!--
@file src/features/settings/ui/RemoteConfigSync.vue
文件职责：用清晰的保存、恢复、端到端口令保护、学习资产合并与可选自动同步流程完成 Google Drive 与 WebDAV 共用的配置云备份。
主要内容：以同级选项依次展示始终同步且不可关闭的基础配置、默认关闭的学习数据（合并单词本、个人校订与阅读材料元数据，开启后提供独立的单词上下文隐私子开关）以及默认关闭的敏感配置；敏感配置须明确同意且风险文案按加密模式自适应，选择在本机持续保存直到手动关闭。
以统一开关卡呈现自定义端到端加密：默认兼容态仅占一行；首次启用通过聚焦弹窗完成口令双输、强度条评估、三档留存分段选择与遗忘风险确认；已解锁态支持一键切换会话/本机留存与锁定；未解锁态（含云端要求口令或口令错误时）内联展示单输入框解锁条并支持回车或直接同步一步完成；关闭加密经确认弹窗原子切回兼容模式，消除半悬空状态。WebDAV 侧额外展示默认关闭的定时自动同步、分段周期与立即安全合并入口。
预览说明旧备份范围、端到端升级提示、学习数据逐类增改数量和恢复保护，不在选项区重复展示范围摘要与恢复提示。
风险确认集中展示存储方式、泄露风险与持续生效的选择；删除确认将云端删除范围、本机保留说明与加粗的确认词合入同一个提示块，输入框紧接其后；次要说明在独立浮层展示，避免展开时改变弹窗与按钮位置。
删除前须输入本次界面语言的确认文本，再点击确认；只删除已核验版本的备份文件，并保留本机配置。
删除入口在核验和删除请求期间显示加载动画，完成或失败后恢复；同步操作不触发删除动画。
通过左侧操作插槽集中显示同步与连接设置，右侧记录插槽统一显示账号和时间，窄屏改为上下排列；预览顶部一行显示本次账号、同步范围标签（说明收在悬停提示里）和更换账号入口；按两步流程说明影响范围，
先选择操作再确认影响，确认页把方向、差异数量与一句影响说明合并在标题下，没有差异时不显示展开按钮和空列表，只有存在被隐藏内容的条目才提示“已隐藏”；WebDAV 内容核验兼容模式提示避免多设备同时同步，仍保留只读供应商的恢复限制；默认展示差异与连接变更类别，小屏保留操作区。
Drive 已上传但未完成核验时单独显示警示，不误报未上传，也不更新成功记录。
模块边界：只消费后台脱敏预览、口令状态与同步记录；不获取完整配置或令牌，单次自定义口令仅在内存短暂持有并随取消或卸载清除，由父级提供存储方式和客户端。
-->
<template>
  <section class="drive-sync" :data-testid="`${kind}-sync`" :aria-busy="busy">
    <slot name="connection" :busy="busy" />
    <div class="cloud-scope" role="group" :aria-label="t('settings.cloud.scopeTitle')" data-testid="cloud-sync-scope">
      <div class="cloud-scope-option">
        <label :for="`${kind}-include-settings`"><strong>{{ t('settings.cloud.basicSettings') }}</strong><span :id="`${kind}-settings-description`">{{ t('settings.cloud.scopeSettingsDescription') }}</span></label>
        <el-switch :id="`${kind}-include-settings`" :model-value="true" disabled :aria-label="t('settings.cloud.basicSettings')" :aria-describedby="`${kind}-settings-description`" data-testid="cloud-include-settings" />
      </div>
      <div class="cloud-scope-option">
        <label :for="`${kind}-include-learning`"><strong>{{ t('settings.cloud.learning.title') }}</strong><span :id="`${kind}-learning-description`">{{ t('settings.cloud.learning.description') }}</span></label>
        <el-switch :id="`${kind}-include-learning`" :model-value="learningEnabled" :disabled="busy || previewVisible" :aria-label="t('settings.cloud.learning.title')" :aria-describedby="`${kind}-learning-description`" data-testid="cloud-include-learning" @change="toggleLearningAll" />
      </div>
      <div v-if="learningEnabled" class="cloud-scope-option cloud-scope-suboption">
        <label :for="`${kind}-include-vocabulary-context`"><strong>{{ t('settings.cloud.learning.vocabularyContext') }}</strong><span :id="`${kind}-vocabulary-context-description`">{{ t('settings.cloud.learning.vocabularyContextDescription') }}</span></label>
        <el-switch :id="`${kind}-include-vocabulary-context`" :model-value="learningScope.includeVocabularyContext" :disabled="busy || previewVisible" :aria-label="t('settings.cloud.learning.vocabularyContext')" :aria-describedby="`${kind}-vocabulary-context-description`" data-testid="cloud-include-vocabulary-context" @change="toggleVocabularyContext" />
      </div>
      <div class="cloud-scope-option">
        <label :for="`${kind}-include-sensitive`"><strong>{{ t('settings.cloud.includeSensitive') }}</strong><span :id="`${kind}-sensitive-description`">{{ t('settings.cloud.sensitiveDescription') }}</span></label>
        <el-switch :id="`${kind}-include-sensitive`" :model-value="includeSensitive" :disabled="busy || previewVisible" :aria-label="t('settings.cloud.includeSensitive')" :aria-describedby="`${kind}-sensitive-description`" data-testid="cloud-include-sensitive" @change="toggleSensitive" />
      </div>
    </div>
    <div v-if="hasPassphraseSupport" class="e2ee" data-testid="cloud-e2ee-section">
      <div class="cloud-scope-option e2ee-row">
        <label :for="`${kind}-e2ee-enabled`">
          <strong class="e2ee-title">
            <span>{{ t('settings.cloud.e2ee.switchTitle') }}</span>
            <span class="e2ee-badge" :class="`is-${e2eeStatusTone}`" role="status" data-testid="cloud-e2ee-status">{{ e2eeStatusText }}</span>
          </strong>
          <span :id="`${kind}-e2ee-description`">{{ t('settings.cloud.e2ee.switchDescription') }}</span>
        </label>
        <el-switch :id="`${kind}-e2ee-enabled`" :model-value="e2eeEnabled" :disabled="busy || previewVisible || e2eeSetupVisible || e2eeDisableVisible" :aria-label="t('settings.cloud.e2ee.switchTitle')" :aria-describedby="`${kind}-e2ee-description`" data-testid="cloud-e2ee-toggle" @change="toggleE2ee" />
      </div>
      <div v-if="showUnlockedBar" class="e2ee-sub" data-testid="cloud-e2ee-unlocked">
        <div class="e2ee-bar">
          <div class="e2ee-ret">
            <span class="e2ee-lbl">{{ t('settings.cloud.e2ee.rememberLabel') }}</span>
            <div class="seg" role="group" :aria-label="t('settings.cloud.e2ee.rememberLabel')">
              <button v-for="scope in (['session', 'device'] as const)" :key="scope" type="button" class="seg-btn" :class="{'is-active': passphraseState?.storageScope === scope}" :aria-pressed="passphraseState?.storageScope === scope" :disabled="busy || previewVisible" :data-testid="`cloud-e2ee-switch-${scope}`" @click="switchStoredRetention(scope)">{{ t(scope === 'session' ? 'settings.cloud.e2ee.rememberSessionTitle' : 'settings.cloud.e2ee.rememberDeviceTitle') }}</button>
            </div>
          </div>
          <el-button size="small" link type="danger" :disabled="busy || previewVisible" data-testid="cloud-e2ee-forget" @click="forgetStoredPassphrase">{{ t('settings.cloud.e2ee.lockAction') }}</el-button>
        </div>
        <p v-if="showAutoSyncRetentionNudge" class="e2ee-nudge" data-testid="cloud-e2ee-autosync-nudge">
          <span>{{ t('settings.cloud.e2ee.autoSyncDeviceHint') }}</span>
          <el-button size="small" link type="primary" :disabled="busy || previewVisible" data-testid="cloud-e2ee-autosync-fix" @click="switchStoredRetention('device')">{{ t('settings.cloud.e2ee.rememberDeviceTitle') }}</el-button>
        </p>
        <p v-if="justEnabledE2ee" class="e2ee-muted" data-testid="cloud-e2ee-upgrade-hint">{{ t('settings.cloud.e2ee.pendingUpgradeHint') }}</p>
      </div>
      <div v-else-if="showEphemeralReadyBar" class="e2ee-sub" data-testid="cloud-e2ee-ephemeral-ready">
        <div class="e2ee-bar">
          <p class="e2ee-ready"><el-icon><CircleCheck /></el-icon><span>{{ t(justEnabledE2ee ? 'settings.cloud.e2ee.pendingUpgradeHint' : 'settings.cloud.e2ee.rememberNoneHint') }}</span></p>
          <el-button size="small" link :disabled="busy || previewVisible" data-testid="cloud-e2ee-clear-ephemeral" @click="clearEphemeralPassphrase">{{ t('settings.cloud.e2ee.lockAction') }}</el-button>
        </div>
      </div>
      <div v-else-if="showUnlockBar" class="e2ee-sub" data-testid="cloud-e2ee-unlock-bar">
        <p class="e2ee-hint" data-testid="cloud-e2ee-unlock-hint">{{ t('settings.cloud.e2ee.passphraseRequired') }}</p>
        <div class="e2ee-unlock">
          <el-input ref="unlockInputRef" :id="`${kind}-e2ee-unlock`" v-model="unlockDraft" type="password" show-password :placeholder="t('settings.cloud.e2ee.passphrasePlaceholder')" :aria-label="t('settings.cloud.e2ee.passphraseLabel')" :disabled="busy || previewVisible" :maxlength="1024" autocomplete="current-password" data-testid="cloud-e2ee-passphrase" @keydown.enter.prevent="submitUnlockOnEnter" />
          <el-button v-if="unlockRemember !== 'none'" :disabled="busy || previewVisible || !unlockLengthValid" data-testid="cloud-e2ee-unlock-btn" @click="applyUnlock">{{ t('settings.cloud.e2ee.unlockButton') }}</el-button>
        </div>
        <div v-if="unlockDraft && !unlockLengthValid" class="e2ee-fb">
          <span class="e2ee-str is-too-short" data-testid="cloud-e2ee-strength">{{ t('settings.cloud.e2ee.strength.too-short') }}</span>
          <span class="e2ee-muted">{{ unlockDraft.trim().length }}/12</span>
        </div>
        <p v-if="e2eeValidationError" class="e2ee-err" role="alert" data-testid="cloud-e2ee-validation-error">{{ e2eeValidationError }}</p>
        <div class="e2ee-ret">
          <span class="e2ee-lbl">{{ t('settings.cloud.e2ee.rememberLabel') }}</span>
          <div class="seg" role="radiogroup" :aria-label="t('settings.cloud.e2ee.rememberLabel')">
            <button v-for="option in retentionOptions" :key="option.value" type="button" role="radio" :aria-checked="unlockRemember === option.value" class="seg-btn" :class="{'is-active': unlockRemember === option.value}" :disabled="busy || previewVisible" @click="unlockRemember = option.value">{{ option.title }}</button>
          </div>
        </div>
        <p class="e2ee-muted">{{ activeUnlockRetentionHint }}</p>
      </div>
    </div>
    <div v-if="hasAutoSyncSupport && status?.available" class="cloud-autosync">
      <div class="cloud-scope-option">
        <label :for="`${kind}-auto-sync-enabled`"><strong>{{ t('settings.cloud.autoSync.title') }}</strong><span :id="`${kind}-auto-sync-description`">{{ t('settings.cloud.autoSync.description') }}</span></label>
        <el-switch :id="`${kind}-auto-sync-enabled`" :model-value="autoSyncState?.enabled === true" :disabled="busy || previewVisible" :aria-label="t('settings.cloud.autoSync.title')" :aria-describedby="`${kind}-auto-sync-description`" data-testid="cloud-auto-sync-enabled" @change="toggleAutoSync" />
      </div>
      <div v-if="autoSyncState" class="cloud-autosync-controls">
        <span class="e2ee-lbl">{{ t('settings.cloud.autoSync.interval') }}</span>
        <div class="seg" role="radiogroup" :aria-label="t('settings.cloud.autoSync.interval')">
          <button v-for="([minutes, suffix]) in autoSyncIntervals" :key="minutes" type="button" role="radio" :aria-checked="autoSyncState.intervalMinutes === minutes" class="seg-btn" :class="{'is-active': autoSyncState.intervalMinutes === minutes}" :disabled="busy || previewVisible" :data-testid="`cloud-auto-sync-interval-${minutes}`" @click="selectAutoSyncInterval(minutes)">{{ t(`settings.cloud.autoSync.interval${suffix}`) }}</button>
        </div>
        <el-button v-if="autoSyncState.enabled" size="small" :disabled="busy || previewVisible" data-testid="cloud-auto-sync-run-now" @click="runAutoSyncNow">{{ t('settings.cloud.autoSync.runNow') }}</el-button>
      </div>
      <p v-if="autoSyncState && autoSyncState.enabled" class="cloud-autosync-status" role="status" data-testid="cloud-auto-sync-status">{{ autoSyncStatusText }}</p>
    </div>
    <el-alert v-if="error && !previewVisible" :title="error" :type="uploadUnverified ? 'warning' : 'error'" :closable="false" show-icon class="drive-error" />
    <el-alert v-if="status?.cleanupPending && !previewVisible" :title="t('settings.cloud.cleanupPending')" type="warning" :closable="false" show-icon class="drive-error" />
    <div class="drive-actions">
      <div class="drive-action-buttons">
        <slot name="actions" :available="status?.available === true" :busy="busy" :sync="prepare">
          <el-button v-if="status?.available" type="primary" :loading="busy" :disabled="busy" :data-testid="`${kind}-sync-now`" @click="prepare">{{ t('settings.cloud.syncNow', {provider}) }}</el-button>
        </slot>
      </div>
      <slot name="record" :status="status" :status-text="statusText">
      <div v-if="status?.account?.email || statusText" class="drive-record" role="status">
        <p v-if="status?.account?.email" :data-testid="`${kind}-last-account`">{{ t('settings.drive.lastAccount', {email: status.account.email}) }}</p>
        <p v-if="statusText" class="drive-status">{{ statusText }}</p>
      </div>
      </slot>
    </div>
    <div v-if="status?.available" class="cloud-delete-entry"><el-button link type="danger" :loading="deleting" :aria-busy="deleting" :disabled="busy || previewVisible || consentVisible || deleteVisible" :data-testid="`${kind}-delete-backup`" @click="prepareDeletion"><el-icon v-if="!deleting"><Delete /></el-icon>{{ t('settings.cloud.deleteBackup') }}</el-button></div>
    <el-dialog v-model="deleteVisible" class="cloud-delete-dialog cloud-compact-dialog fluentread-cloud-sync-dialog" :title="t(deletion?.hasRemote ? 'settings.cloud.deleteTitle' : 'settings.cloud.deleteAbsent')" width="min(480px, calc(100vw - 24px))" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" :before-close="cancelDeletion" destroy-on-close @closed="deletion = null">
      <template v-if="deletion">
        <div class="cloud-delete-account"><div class="cloud-delete-target"><strong><slot name="delete-account">{{ deletion.account.email || t('settings.cloud.selectedAccount') }}</slot></strong><slot name="delete-location" /></div><el-button v-if="kind === 'google-drive'" link :disabled="busy" data-testid="google-drive-delete-switch-account" @click="changeDeletionAccount">{{ t('settings.cloud.changeAccount') }}</el-button></div>
        <div v-if="deletion.hasRemote" class="cloud-delete-impact" data-testid="cloud-delete-impact">
          <el-icon><Warning /></el-icon>
          <div class="cloud-delete-impact-content">
            <strong>{{ t('settings.cloud.deleteCloudEffect', {provider}) }}</strong><p>{{ t('settings.cloud.deleteDescription') }}</p>
            <label v-if="deletion.canDelete" :for="`${kind}-delete-verification`" :id="`${kind}-delete-instruction`" class="cloud-delete-instruction">{{ deleteInstruction[0] }}<strong data-testid="cloud-delete-phrase">{{ t('settings.cloud.deletePhrase') }}</strong>{{ deleteInstruction[1] }}</label>
          </div>
        </div>
        <p v-else class="cloud-delete-description">{{ t('settings.cloud.deleteAbsentDescription') }}</p>
        <div v-if="deletion.hasRemote && deletion.canDelete" class="cloud-delete-verification" data-testid="cloud-delete-verification">
          <el-input :id="`${kind}-delete-verification`" v-model="deleteConfirmation" :placeholder="t('settings.cloud.deleteVerification', {phrase: t('settings.cloud.deletePhrase')})" :aria-label="t('settings.cloud.deleteVerification', {phrase: t('settings.cloud.deletePhrase')})" :aria-describedby="`${kind}-delete-instruction`" :disabled="busy" :maxlength="64" autocomplete="off" :spellcheck="false" @keydown.enter.prevent />
        </div>
        <el-alert v-if="deletion.hasRemote && !deletion.canDelete" :title="t('settings.cloud.deleteUnsupported')" :description="t(kind === 'google-drive' ? 'settings.cloud.deleteManualDrive' : 'settings.cloud.deleteManualWebDav')" type="warning" :closable="false" show-icon data-testid="cloud-delete-unsupported" />
        <el-alert v-else-if="deletion.requiresExclusiveAccess" :title="t('settings.webdav.concurrentWarning')" type="warning" :closable="false" show-icon data-testid="webdav-delete-compatibility" />
      </template>
      <template #footer><div class="cloud-delete-footer">
        <el-popover v-if="deletion?.hasRemote" v-model:visible="deleteDetailsVisible" role="dialog" :title="t('settings.cloud.deleteDetails')" trigger="click" placement="top-start" width="min(320px, calc(100vw - 40px))" :persistent="false" :hide-after="0" popper-class="fluentread-cloud-delete-help">
          <template #reference><el-button link class="cloud-delete-details-toggle" :disabled="busy" data-testid="cloud-delete-details-toggle" @keydown.esc.stop.prevent="deleteDetailsVisible = false">{{ t('settings.cloud.deleteDetails') }}<el-icon><component :is="deleteDetailsVisible ? ArrowUp : ArrowDown" /></el-icon></el-button></template>
          <div :id="`${kind}-delete-details`" class="cloud-delete-details"><p class="cloud-delete-note">{{ t('settings.cloud.deleteHistory') }}</p><p class="cloud-delete-note">{{ t('settings.cloud.deleteRecreate') }}</p></div>
        </el-popover>
        <div class="cloud-consent-actions"><el-button :disabled="busy" data-testid="cloud-delete-cancel" @click="cancelDeletion">{{ t('settings.drive.cancelSync') }}</el-button><el-button type="primary" :loading="busy" :disabled="busy || !canConfirmDeletion" data-testid="cloud-delete-confirm" @click="confirmDeletion">{{ t(deletion?.hasRemote ? 'settings.cloud.deleteConfirm' : 'settings.cloud.deleteFinish') }}</el-button></div>
      </div></template>
    </el-dialog>
    <el-dialog v-model="e2eeSetupVisible" class="cloud-compact-dialog fluentread-cloud-sync-dialog" :title="t('settings.cloud.e2ee.switchTitle')" width="min(500px, calc(100vw - 24px))" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" destroy-on-close @closed="resetSetupDialog">
      <div class="cloud-consent-risk"><el-icon><Warning /></el-icon><p>{{ t('settings.cloud.e2ee.warning') }}</p></div>
      <div class="e2ee-form">
        <div class="e2ee-field">
          <label :for="`${kind}-e2ee-setup-passphrase`">{{ t('settings.cloud.e2ee.passphraseLabel') }}</label>
          <el-input :id="`${kind}-e2ee-setup-passphrase`" v-model="setupPassphrase" type="password" show-password :placeholder="t('settings.cloud.e2ee.passphrasePlaceholder')" :disabled="busy" :maxlength="1024" autocomplete="new-password" data-testid="cloud-e2ee-setup-passphrase" @keydown.enter.prevent="submitSetupOnEnter" />
          <div v-if="setupPassphrase" class="e2ee-fb">
            <div class="e2ee-meter">
              <span class="e2ee-bars" :class="`is-${setupStrength}`" aria-hidden="true"><span /><span /><span /></span>
              <span class="e2ee-str" :class="`is-${setupStrength}`" data-testid="cloud-e2ee-setup-strength">{{ setupStrengthLabel }}</span>
            </div>
            <span v-if="setupStrength === 'too-short'" class="e2ee-muted">{{ setupPassphrase.trim().length }}/12</span>
          </div>
        </div>
        <div class="e2ee-field">
          <label :for="`${kind}-e2ee-setup-confirm`">{{ t('settings.cloud.e2ee.confirmLabel') }}</label>
          <el-input :id="`${kind}-e2ee-setup-confirm`" v-model="setupConfirm" type="password" show-password :placeholder="t('settings.cloud.e2ee.confirmPlaceholder')" :disabled="busy" :maxlength="1024" autocomplete="new-password" data-testid="cloud-e2ee-setup-confirm" @keydown.enter.prevent="submitSetupOnEnter" />
          <p v-if="setupMismatch" class="e2ee-err" role="alert" data-testid="cloud-e2ee-setup-mismatch">{{ t('settings.cloud.e2ee.mismatch') }}</p>
          <p v-else-if="setupLengthValid && !setupConfirm" class="e2ee-muted" data-testid="cloud-e2ee-setup-confirm-hint">{{ t('settings.cloud.e2ee.confirmPlaceholder') }}</p>
        </div>
        <div class="e2ee-field">
          <span class="e2ee-lbl">{{ t('settings.cloud.e2ee.rememberLabel') }}</span>
          <div class="seg seg-3" role="radiogroup" :aria-label="t('settings.cloud.e2ee.rememberLabel')" data-testid="cloud-e2ee-setup-remember">
            <button v-for="option in retentionOptions" :key="option.value" type="button" role="radio" :aria-checked="setupRemember === option.value" class="seg-btn" :class="{'is-active': setupRemember === option.value}" :disabled="busy" :data-testid="`cloud-e2ee-setup-remember-${option.value}`" @click="setupRemember = option.value">{{ option.title }}</button>
          </div>
          <p class="e2ee-muted" data-testid="cloud-e2ee-setup-remember-hint">{{ activeSetupRetentionHint }}</p>
        </div>
        <label class="cloud-consent-checkbox"><input v-model="setupAcknowledged" type="checkbox" :disabled="busy" data-testid="cloud-e2ee-setup-ack" /><span>{{ t('settings.cloud.e2ee.setupAcknowledge') }}</span></label>
        <p class="e2ee-muted">{{ t('settings.cloud.e2ee.pendingUpgradeHint') }}</p>
      </div>
      <template #footer><div class="cloud-consent-actions"><el-button :disabled="busy" data-testid="cloud-e2ee-setup-cancel" @click="e2eeSetupVisible = false">{{ t('settings.drive.cancelSync') }}</el-button><el-button type="primary" :loading="busy" :disabled="busy || !canSubmitSetup" data-testid="cloud-e2ee-setup-confirm-btn" @click="confirmSetupE2ee">{{ t('settings.cloud.consentConfirm') }}</el-button></div></template>
    </el-dialog>
    <el-dialog v-model="e2eeDisableVisible" class="cloud-compact-dialog fluentread-cloud-sync-dialog" :title="t('settings.cloud.e2ee.switchToLegacyAction')" width="min(460px, calc(100vw - 24px))" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" destroy-on-close>
      <div class="cloud-consent-risk"><el-icon><Warning /></el-icon><p>{{ t('settings.cloud.e2ee.switchToLegacyNotice') }}</p></div>
      <template #footer><div class="cloud-consent-actions"><el-button :disabled="busy" data-testid="cloud-e2ee-disable-cancel" @click="e2eeDisableVisible = false">{{ t('settings.drive.cancelSync') }}</el-button><el-button type="primary" :loading="busy" :disabled="busy" data-testid="cloud-e2ee-disable-confirm" @click="confirmDisableE2ee">{{ t('settings.cloud.e2ee.switchToLegacyAction') }}</el-button></div></template>
    </el-dialog>
    <el-dialog v-model="consentVisible" class="cloud-consent-dialog cloud-compact-dialog fluentread-cloud-sync-dialog" :title="t('settings.cloud.consentTitle')" width="min(480px, calc(100vw - 24px))" destroy-on-close @closed="riskAcknowledged = false">
      <p class="cloud-consent-intro">{{ t('settings.cloud.consentStorage', {provider}) }}</p>
      <div class="cloud-consent-risk"><el-icon><Warning /></el-icon><p data-testid="cloud-consent-risk-text">{{ t(e2eeEnabled ? 'settings.cloud.e2ee.consentRisk' : 'settings.cloud.consentRisk', {provider}) }}</p></div>
      <label class="cloud-consent-checkbox"><input v-model="riskAcknowledged" type="checkbox" data-testid="cloud-risk-acknowledgement" /><span>{{ t('settings.cloud.consentAcknowledgement') }}</span></label>
      <template #footer><div class="cloud-consent-actions"><el-button data-testid="cloud-consent-cancel" @click="consentVisible = false">{{ t('settings.drive.cancelSync') }}</el-button><el-button type="primary" :disabled="!riskAcknowledged" data-testid="cloud-consent-confirm" @click="confirmSensitive">{{ t('settings.cloud.consentConfirm') }}</el-button></div></template>
    </el-dialog>
    <el-dialog class="drive-dialog fluentread-cloud-sync-dialog" v-model="previewVisible" :title="t('settings.drive.previewTitle')" width="min(820px, calc(100vw - 24px))" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" :before-close="cancelPreview" destroy-on-close @closed="clearPreview">
      <template v-if="preview">
        <div class="drive-account-bar">
          <el-icon class="drive-account-icon"><User /></el-icon>
          <p>{{ preview.account.email ? t('settings.drive.account', {email: preview.account.email}) : t('settings.drive.selectedAccount') }}</p>
          <span class="cloud-preview-scope" role="status" data-testid="cloud-preview-scope" :title="t(preview.includeSensitive ? 'settings.cloud.previewSensitive' : 'settings.cloud.preserveLocal')" :aria-label="`${t(preview.includeSensitive ? 'settings.cloud.scopeSensitive' : 'settings.cloud.scopeSettings')}：${t(preview.includeSensitive ? 'settings.cloud.previewSensitive' : 'settings.cloud.preserveLocal')}`"><strong>{{ t(preview.includeSensitive ? 'settings.cloud.scopeSensitive' : 'settings.cloud.scopeSettings') }}</strong></span>
          <el-button v-if="kind === 'google-drive'" link :loading="switchingAccount" :disabled="busy" :data-testid="`${kind}-switch-account`" @click="switchAccount">{{ t('settings.drive.switchAccount') }}</el-button>
        </div>
        <el-alert v-if="preview.keyMode === 'custom' && preview.remoteKeyMode === 'app'" :title="t('settings.cloud.e2ee.upgradeNotice')" type="info" :closable="false" show-icon class="drive-error drive-preview-notice" data-testid="cloud-e2ee-upgrade-notice" />
        <el-alert v-if="preview.remoteIncludesSensitive && !preview.includeSensitive" :title="t('settings.cloud.legacySensitive')" type="warning" :closable="false" show-icon class="drive-error drive-preview-notice" data-testid="cloud-legacy-sensitive" />
        <el-alert v-else-if="preview.hasRemote && preview.includeSensitive && !preview.remoteIncludesSensitive" :title="t('settings.cloud.remoteSettingsOnly')" type="info" :closable="false" show-icon class="drive-error drive-preview-notice" />
        <el-alert v-if="error" :title="error" :type="uploadUnverified ? 'warning' : 'error'" :closable="false" show-icon class="drive-error drive-preview-notice" />
        <el-alert v-if="preview.canUpload === false" :title="t('settings.cloud.restoreOnly')" type="warning" :closable="false" show-icon class="drive-error drive-preview-notice" :data-testid="`${kind}-restore-only`" />
        <el-alert v-else-if="preview.requiresExclusiveAccess" :title="t('settings.webdav.concurrentWarning')" type="warning" :closable="false" show-icon class="drive-error drive-preview-notice" data-testid="webdav-sync-compatibility" />
        <div v-if="activeLearningSummaryItems.length" class="cloud-learning-preview" data-testid="cloud-learning-preview">
          <strong>{{ t('settings.cloud.learning.previewTitle') }}</strong>
          <ul>
            <li v-for="item in activeLearningSummaryItems" :key="item.key" :data-testid="`cloud-learning-diff-${item.key}`">
              <span>{{ item.label }}</span>
              <span>{{ item.summary }}</span>
            </li>
          </ul>
        </div>

        <ol v-if="preview.hasRemote && !identical && preview.canUpload !== false" class="drive-steps" :aria-label="t('settings.drive.stepsLabel')">
          <li :class="{'is-current': step === 'choose'}" :aria-current="step === 'choose' ? 'step' : undefined"><span>1</span>{{ t('settings.drive.chooseStep') }}</li>
          <li :class="{'is-current': step === 'review'}" :aria-current="step === 'review' ? 'step' : undefined"><span>2</span>{{ t('settings.drive.reviewStep') }}</li>
        </ol>

        <div v-if="!preview.hasRemote || identical" class="drive-summary drive-summary-positive">
          <el-icon><CircleCheck /></el-icon>
          <div><h3>{{ t(identical ? 'settings.drive.identicalTitle' : 'settings.drive.firstTitle') }}</h3><p>{{ t(identical ? 'settings.drive.identicalDescription' : 'settings.drive.firstDescription') }}</p></div>
        </div>
        <template v-else-if="step === 'choose'">
          <div class="drive-intent-heading"><h3>{{ t('settings.drive.chooseTitle') }}</h3><p>{{ t(preview.canUpload === false ? 'settings.drive.downloadDescription' : preview.hasBaseline ? 'settings.drive.returningDescription' : 'settings.drive.firstRestoreDescription') }}</p></div>
          <div class="drive-operation-list" role="radiogroup" :aria-label="t('settings.drive.chooseStep')">
            <label v-for="operation in ['download', 'upload'] as const" :key="operation" class="drive-operation" :class="{'is-selected': direction === operation, 'is-disabled': busy || operation === 'upload' && preview.canUpload === false}">
              <input v-model="direction" type="radio" name="drive-operation" :value="operation" :disabled="busy || operation === 'upload' && preview.canUpload === false" :data-testid="`${kind}-direction-${operation}`" />
              <span><strong>{{ t(`settings.drive.${operation}Title`) }}</strong><span>{{ t(`settings.drive.${operation}Description`) }}</span></span>
            </label>
          </div>
          <div v-if="preview.canUpload !== false" class="drive-advanced">
            <p>{{ t('settings.drive.mergeQuestion') }}</p>
            <el-button link :disabled="busy" :data-testid="`${kind}-direction-merge`" @click="selectMerge"><el-icon><Switch /></el-icon>{{ t('settings.drive.mergeReviewTitle') }}<el-icon><ArrowRight /></el-icon></el-button>
          </div>
        </template>
        <template v-else>
            <div class="drive-review-title">
              <span class="drive-review-icon"><el-icon><component :is="direction === 'merge' ? Switch : direction === 'download' ? Download : Upload" /></el-icon></span>
              <div>
                <h3>{{ t(direction === 'merge' ? 'settings.drive.mergeReviewTitle' : `settings.drive.${direction}Title`) }}</h3>
                <p class="drive-review-meta">
                  <span v-if="direction !== 'merge'" class="drive-review-route">{{ t(direction === 'download' ? 'settings.drive.cloudLabel' : 'settings.drive.deviceLabel') }}<el-icon aria-hidden="true"><ArrowRight /></el-icon>{{ t(direction === 'download' ? 'settings.drive.deviceLabel' : 'settings.drive.cloudLabel') }}</span>
                  <span>{{ t('settings.drive.differenceCount', {count: preview.changes.length}) }}</span>
                </p>
              </div>
            </div>
            <p class="drive-impact">{{ directionHint }}</p>
            <div v-if="direction === 'merge' && conflictRows.length" class="drive-review-heading">
              <div><h3>{{ t('settings.drive.reviewConflicts') }}</h3><p>{{ t('settings.drive.remaining', {count: unresolved}) }}</p></div>
              <div class="drive-bulk-actions">
                <el-button size="small" :disabled="busy" @click="chooseAll('local')">{{ t('settings.drive.keepAllLocal') }}</el-button>
                <el-button size="small" :disabled="busy" @click="chooseAll('remote')">{{ t('settings.drive.keepAllRemote') }}</el-button>
              </div>
            </div>
            <p v-else-if="direction === 'merge'" class="drive-merge-ready"><el-icon><CircleCheck /></el-icon>{{ summaryTitle }}</p>
            <button v-if="direction !== 'merge' && activeRows.length" type="button" class="drive-details-toggle" :aria-expanded="detailsVisible" @click="toggleDetails"><span>{{ t(detailsVisible ? 'settings.drive.hideDetails' : 'settings.drive.showDetails', {count: preview.changes.length}) }}</span><el-icon><component :is="detailsVisible ? ArrowUp : ArrowDown" /></el-icon></button>
            <button v-else-if="automaticRows.length" type="button" class="drive-details-toggle" :aria-expanded="automaticVisible" @click="toggleAutomatic"><span>{{ t(automaticVisible ? 'settings.drive.hideAutomatic' : 'settings.drive.showAutomatic', {count: automaticCount}) }}</span><el-icon><component :is="automaticVisible ? ArrowUp : ArrowDown" /></el-icon></button>
            <template v-if="activeRows.length > 0 && (direction === 'merge' || detailsVisible)">
              <p v-if="hasMaskedRows" class="drive-private-hint">{{ t('settings.drive.privateHint') }}</p>
              <div class="drive-differences" :data-testid="`${kind}-differences`">
                <article v-for="row in visibleRows" :key="row.id" class="drive-change" :class="{'is-compact': direction !== 'merge'}" :data-change-id="row.id">
                  <div class="drive-change-heading"><strong>{{ row.label === '私密或自定义设置' ? t('settings.drive.otherSettings') : translateLegacy(row.label) }}</strong>
                    <span v-if="direction === 'merge'" :class="{'is-pending': !rowChoice(row)}">{{ t(rowChoice(row) ? (rowChoice(row) === 'local' ? 'settings.drive.localSelected' : 'settings.drive.remoteSelected') : 'settings.drive.needsChoice') }}</span>
                  </div>
                  <p v-if="row.changes.some(change => change.details?.length)" class="drive-change-details">{{ [...new Set(row.changes.flatMap(change => change.details ?? []))].map(key => t(key)).join(' · ') }}</p>
                  <div v-if="direction === 'merge'" class="drive-values" role="radiogroup" :aria-label="t('settings.drive.choice', {label: row.label === '私密或自定义设置' ? t('settings.drive.otherSettings') : translateLegacy(row.label)})">
                    <label v-for="source in ['local', 'remote'] as const" :key="source" class="drive-value" :class="{'is-selected': rowChoice(row) === source}">
                      <input type="radio" :name="`drive-choice-${row.id}`" :checked="rowChoice(row) === source" :disabled="busy" :value="source" @change="chooseRow(row, source)" />
                      <span><strong>{{ t(source === 'local' ? 'settings.drive.deviceLabel' : 'settings.drive.cloudLabel') }}</strong><span>{{ rowValue(row, source) }}</span></span>
                    </label>
                  </div>
                  <!-- 保存或恢复是整体替换：一行给出“被替换一侧的值 → 替换后的值”，两侧各带来源标签，不再并排两个方框。 -->
                  <p v-else class="drive-change-flow">
                    <template v-if="row.changes.length === 1">
                      <span class="drive-change-from"><small>{{ t(direction === 'upload' ? 'settings.drive.cloudLabel' : 'settings.drive.deviceLabel') }}</small>{{ rowValue(row, direction === 'upload' ? 'remote' : 'local') }}</span>
                      <el-icon aria-hidden="true"><ArrowRight /></el-icon>
                      <span class="drive-change-to"><small>{{ t(direction === 'upload' ? 'settings.drive.deviceLabel' : 'settings.drive.cloudLabel') }}</small>{{ rowValue(row, direction === 'upload' ? 'local' : 'remote') }}</span>
                    </template>
                    <span v-else class="drive-change-to">{{ rowValue(row, 'local') }}</span>
                  </p>
                </article>
              </div>
              <el-pagination v-if="activeRows.length > 20" v-model:current-page="page" :page-size="20" :total="activeRows.length" layout="prev, pager, next" />
            </template>
        </template>
      </template>
      <template #footer>
        <p v-if="step === 'review' && direction === 'merge' && unresolved" class="drive-footer-hint" role="status">{{ t('settings.drive.remaining', {count: unresolved}) }}</p>
        <div class="drive-footer-row">
          <el-button v-if="step === 'review' && preview?.hasRemote && !identical && preview.canUpload !== false" link :disabled="busy" :data-testid="`${kind}-back`" @click="backToChoose"><el-icon><ArrowLeft /></el-icon>{{ t('settings.drive.back') }}</el-button>
          <div class="drive-footer-actions"><el-button :disabled="busy" @click="cancelPreview">{{ t('settings.drive.cancelSync') }}</el-button><el-button v-if="step === 'choose'" type="primary" :disabled="busy || !direction" :data-testid="`${kind}-continue`" @click="step = 'review'">{{ t('settings.drive.continue') }}</el-button><el-button v-else type="primary" :loading="busy && !switchingAccount" :disabled="busy || !canCommit" :data-testid="`${kind}-confirm`" @click="commit">{{ commitLabel }}</el-button></div>
        </div>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import {computed, nextTick, onMounted, onUnmounted, reactive, ref, watch} from 'vue';
import {ElAlert, ElIcon, ElInput, ElMessage, ElPagination, ElPopover, ElSwitch} from 'element-plus';
import {ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CircleCheck, Delete, Download, Switch, Upload, User, Warning} from '@element-plus/icons-vue';
import 'element-plus/es/components/alert/style/css';
import 'element-plus/es/components/input/style/css';
import 'element-plus/es/components/pagination/style/css';
import 'element-plus/es/components/popover/style/css';
import 'element-plus/es/components/switch/style/css';
import {useUiI18n} from '@/src/ui/i18n';
import {CloudBackupRequestError, type CloudBackupCommitOptions, type CloudBackupPrepareOptions, type createCloudBackupClient} from '@/src/services/config/cloudBackupClient';
import {evaluatePassphraseStrength} from '@/src/platform/google-drive/encryption';
import {DEFAULT_LEARNING_SYNC_SCOPE, hasAnyLearningSyncScope, type LearningSyncScope} from '@/src/core/config/learningSync';
import type {CloudPassphraseConfigInput, CloudPassphraseRememberScope, CloudPassphraseStatus} from '@/src/services/config/cloudPassphraseStore';
import type {CloudAutoSyncConfigPatch, CloudAutoSyncIntervalMinutes, CloudAutoSyncStatus} from '@/src/services/config/cloudAutoSync';
import {chooseDriveRow, driveRowChoice, groupDrivePreviewChanges, initialDriveDirection, localizeDrivePreviewLanguage, unresolvedDriveChanges, type DrivePreviewRow} from '../model/googleDrivePreview';
import type {DriveChoice} from '@/src/core/config/driveSync';
import type {DriveSyncDirection, DriveSyncPreview, DriveSyncStatus} from '@/src/services/config/googleDriveSync';
import type {CloudBackupDeletePreview} from '@/src/services/config/remoteConfigSync';

type SyncClient = Pick<ReturnType<typeof createCloudBackupClient>, 'status' | 'prepare' | 'commit' | 'cancel' | 'prepareDelete' | 'commitDelete'> & {
  passphraseStatus?: () => Promise<CloudPassphraseStatus>;
  configurePassphrase?: (input: CloudPassphraseConfigInput) => Promise<CloudPassphraseStatus>;
  clearPassphrase?: () => Promise<CloudPassphraseStatus>;
  autoSyncStatus?: () => Promise<CloudAutoSyncStatus>;
  configureAutoSync?: (patch: CloudAutoSyncConfigPatch) => Promise<CloudAutoSyncStatus>;
  runAutoSyncNow?: () => Promise<CloudAutoSyncStatus>;
};

const props = defineProps<{client: SyncClient; provider: string; kind: 'google-drive' | 'webdav'}>();
const emit = defineEmits<{busy: [value: boolean]}>();
const {t: baseT, translateLegacy, language} = useUiI18n();
const client = props.client;
const mapping: Record<string, string> = {'settings.drive.downloadDescription': 'settings.cloud.downloadDescription', 'settings.drive.uploadDescription': 'settings.cloud.uploadDescription', 'settings.drive.firstTitle': 'settings.cloud.firstTitle', 'settings.drive.selectedAccount': 'settings.cloud.selectedAccount'};
function t(key: string, params?: Record<string, string | number>) {return baseT(mapping[key] ?? key, {...params, provider: props.provider});}

const hasPassphraseSupport = computed(() => typeof client.passphraseStatus === 'function' && typeof client.configurePassphrase === 'function' && typeof client.clearPassphrase === 'function');
const hasAutoSyncSupport = computed(() => typeof client.autoSyncStatus === 'function' && typeof client.configureAutoSync === 'function' && typeof client.runAutoSyncNow === 'function');

const status = ref<DriveSyncStatus | null>(null);
const busy = ref(false);
const deleting = ref(false);
const includeSensitive = ref(false);
const sensitivePreferenceKey = 'fluentread-cloud-backup-include-sensitive';
const learningPreferenceKey = 'fluentread-cloud-backup-learning-scope';
try {includeSensitive.value = localStorage.getItem(sensitivePreferenceKey) === 'true';} catch { /* 无法读取已保存选择时保持默认关闭。 */ }
const learningScope = reactive<LearningSyncScope>({...DEFAULT_LEARNING_SYNC_SCOPE});
const learningEnabled = computed(() => learningScope.includeVocabulary || learningScope.includePersonalCorrections || learningScope.includeReadingMaterials);
function loadLearningPreference() {
  try {
    const raw = localStorage.getItem(learningPreferenceKey);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<LearningSyncScope>;
    const enabled = parsed.includeVocabulary === true || parsed.includePersonalCorrections === true || parsed.includeReadingMaterials === true;
    learningScope.includeVocabulary = enabled;
    learningScope.includePersonalCorrections = enabled;
    learningScope.includeReadingMaterials = enabled;
    learningScope.includeVocabularyContext = enabled && parsed.includeVocabularyContext === true;
  } catch { /* 无法读取学习同步偏好时保持默认全部关闭。 */ }
}
loadLearningPreference();

const passphraseState = ref<CloudPassphraseStatus | null>(null);
const e2eeSetupVisible = ref(false);
const e2eeDisableVisible = ref(false);
const setupPassphrase = ref('');
const setupConfirm = ref('');
const setupRemember = ref<CloudPassphraseRememberScope>('session');
const setupAcknowledged = ref(false);
const unlockDraft = ref('');
const unlockRemember = ref<CloudPassphraseRememberScope>('session');
const unlockInputRef = ref<{focus?: () => void} | null>(null);
const ephemeralReadyPassphrase = ref<string | undefined>(undefined);
const remoteRequiresUnlock = ref(false);
const forceUnlockPrompt = ref(false);
const justEnabledE2ee = ref(false);
const e2eeValidationError = ref('');
const activeEphemeralPassphrase = ref<string | undefined>(undefined);
const pendingPassphrasePersist = ref<{rememberScope: CloudPassphraseRememberScope; passphrase: string} | null>(null);

const e2eeEnabled = computed(() => passphraseState.value?.mode === 'custom' || remoteRequiresUnlock.value);
const showUnlockedBar = computed(() => passphraseState.value?.mode === 'custom' && passphraseState.value.hasStoredPassphrase && !forceUnlockPrompt.value);
const showEphemeralReadyBar = computed(() => !showUnlockedBar.value && e2eeEnabled.value && Boolean(ephemeralReadyPassphrase.value));
const showUnlockBar = computed(() => e2eeEnabled.value && !showUnlockedBar.value && !showEphemeralReadyBar.value);

const setupStrength = computed(() => evaluatePassphraseStrength(setupPassphrase.value));
const setupStrengthLabel = computed(() => t(`settings.cloud.e2ee.strength.${setupStrength.value}`));
const setupLengthValid = computed(() => setupPassphrase.value.trim().length >= 12 && setupPassphrase.value.length <= 1024);
const setupMismatch = computed(() => Boolean(setupConfirm.value && setupPassphrase.value !== setupConfirm.value));
const canSubmitSetup = computed(() => setupLengthValid.value && setupPassphrase.value === setupConfirm.value && setupAcknowledged.value);

const unlockLengthValid = computed(() => unlockDraft.value.trim().length >= 12 && unlockDraft.value.length <= 1024);
const canSyncWithCustomPassphrase = computed(() => showUnlockedBar.value || showEphemeralReadyBar.value || unlockLengthValid.value);

const retentionOptions = computed(() => [
  {value: 'none' as const, title: t('settings.cloud.e2ee.rememberNoneTitle'), hint: t('settings.cloud.e2ee.rememberNoneHint')},
  {value: 'session' as const, title: t('settings.cloud.e2ee.rememberSessionTitle'), hint: t('settings.cloud.e2ee.rememberSessionHint')},
  {value: 'device' as const, title: t('settings.cloud.e2ee.rememberDeviceTitle'), hint: t('settings.cloud.e2ee.rememberDeviceHint')},
]);
const activeSetupRetentionHint = computed(() => retentionOptions.value.find(item => item.value === setupRemember.value)?.hint ?? '');
const activeUnlockRetentionHint = computed(() => retentionOptions.value.find(item => item.value === unlockRemember.value)?.hint ?? '');
const showAutoSyncRetentionNudge = computed(() => hasAutoSyncSupport.value && autoSyncState.value?.enabled === true && passphraseState.value?.storageScope !== 'device');
const autoSyncIntervals = [[30, '30m'], [60, '60m'], [360, '6h'], [1440, '24h']] as const;

const e2eeStatusTone = computed<'legacy' | 'unlocked' | 'ready' | 'locked'>(() => {
  if (!e2eeEnabled.value) return 'legacy';
  if (showUnlockedBar.value) return 'unlocked';
  if (showEphemeralReadyBar.value || (unlockRemember.value === 'none' && unlockLengthValid.value)) return 'ready';
  return 'locked';
});
const e2eeStatusText = computed(() => {
  if (!e2eeEnabled.value) return t('settings.cloud.e2ee.badgeLegacy');
  if (showUnlockedBar.value) {
    return t(passphraseState.value?.storageScope === 'device' ? 'settings.cloud.e2ee.rememberDeviceTitle' : 'settings.cloud.e2ee.rememberSessionTitle');
  }
  if (showEphemeralReadyBar.value || (unlockRemember.value === 'none' && unlockLengthValid.value)) return t('settings.cloud.e2ee.rememberNoneTitle');
  return t('settings.cloud.e2ee.badgeLocked');
});
watch([unlockDraft, unlockRemember], () => {e2eeValidationError.value = '';});

const autoSyncState = ref<CloudAutoSyncStatus | null>(null);
const autoSyncStatusKey: Record<CloudAutoSyncStatus['state'], string> = {synced: 'Synced', conflict: 'Conflict', 'passphrase-locked': 'Locked', offline: 'Offline', error: 'Error', idle: 'Idle'};
const autoSyncStatusText = computed(() => {
  const c = autoSyncState.value;
  return c ? t(`settings.cloud.autoSync.status${autoSyncStatusKey[c.state]}`, {count: c.conflictCount || 1}) : '';
});

const consentVisible = ref(false);
const riskAcknowledged = ref(false);
const switchingAccount = ref(false);
const error = ref('');
const uploadUnverified = ref(false);
const preview = ref<DriveSyncPreview | null>(null);
const previewVisible = ref(false);
const deletion = ref<CloudBackupDeletePreview | null>(null);
const deleteVisible = ref(false);
const deleteDetailsVisible = ref(false);
const deleteConfirmation = ref('');
const deleteInstruction = computed(() => t('settings.cloud.deleteVerificationPrompt', {phrase: '{phrase}'}).split('{phrase}'));
const canConfirmDeletion = computed(() => Boolean(deleteVisible.value && deletion.value?.canDelete && (!deletion.value.hasRemote || deleteConfirmation.value === t('settings.cloud.deletePhrase'))));
watch(() => busy.value || consentVisible.value || previewVisible.value || deleteVisible.value || e2eeSetupVisible.value || e2eeDisableVisible.value, value => emit('busy', value));
watch(deleteVisible, value => {if (!value) deleteDetailsVisible.value = false;});
const direction = ref<DriveSyncDirection | ''>('');
const step = ref<'choose' | 'review'>('review');
const choices = ref<Record<string, string>>({});
const page = ref(1);
const detailsVisible = ref(false);
const automaticVisible = ref(false);
const identical = computed(() => Boolean(
  preview.value?.hasRemote
  && !preview.value.changes.length
  && preview.value.includeSensitive === preview.value.remoteIncludesSensitive
  && !preview.value.learningSummary?.hasAnyChanges
  && !(preview.value.keyMode === 'custom' && preview.value.remoteKeyMode === 'app'),
));
const activeLearningSummaryItems = computed(() => {
  const summary = preview.value?.learningSummary;
  if (!summary) return [];
  const entries = [
    {key: 'vocabulary', label: t('settings.cloud.learning.vocabulary'), item: summary.vocabulary},
    {key: 'corrections', label: t('settings.cloud.learning.corrections'), item: summary.personalCorrections},
    {key: 'materials', label: t('settings.cloud.learning.materials'), item: summary.readingMaterials},
  ];
  return entries.filter(entry => entry.item.enabled).map(entry => ({
    key: entry.key,
    label: entry.label,
    summary: entry.item.hasChanges
      ? t('settings.cloud.learning.diffSummary', {
        local: entry.item.localCount,
        remote: entry.item.remoteCount,
        added: entry.item.addedFromRemote,
        updated: entry.item.updatedFromRemote,
      })
      : t('settings.cloud.learning.noChanges', {count: entry.item.localCount}),
  }));
});
const rows = computed(() => groupDrivePreviewChanges(preview.value?.changes ?? []));
const conflictRows = computed(() => rows.value.filter(row => !row.recommended));
const automaticRows = computed(() => rows.value.filter(row => row.recommended));
const automaticCount = computed(() => automaticRows.value.reduce((count, row) => count + row.changes.length, 0));
const activeRows = computed(() => direction.value === 'merge' ? [...conflictRows.value, ...(automaticVisible.value ? automaticRows.value : [])] : rows.value);
const visibleRows = computed(() => activeRows.value.slice((page.value - 1) * 20, page.value * 20));
// 只有列表里确实有被隐藏内容的条目时，才提示“已隐藏”。
const hasMaskedRows = computed(() => activeRows.value.some(row => row.changes.some(change => change.sensitive)));
const unresolved = computed(() => preview.value ? unresolvedDriveChanges(preview.value, choices.value) : 0);
const statusText = computed(() => !status.value ? translateLegacy('正在检查同步状态…') : !status.value.available ? translateLegacy(status.value.reason) : status.value.lastSyncedAt ? t('settings.drive.lastSync', {time: new Date(status.value.lastSyncedAt).toLocaleString(language.value)}) : '');
const directionHint = computed(() => direction.value === 'merge' && !preview.value?.hasBaseline ? t('settings.drive.firstMergeDescription') : direction.value ? t(`settings.drive.${direction.value}Description`) : '');
const summaryTitle = computed(() => t('settings.drive.mergeReady'));
const commitLabel = computed(() => t(identical.value ? 'settings.drive.finishSync' : direction.value ? `settings.drive.${direction.value}Action` : 'settings.drive.chooseAction'));
const canCommit = computed(() => Boolean(preview.value && direction.value && (preview.value.canUpload !== false || direction.value === 'download') && (direction.value !== 'merge' || unresolved.value === 0)));
watch(direction, () => {page.value = 1; detailsVisible.value = true; automaticVisible.value = true;});
function previewValueLabel(value: string) {return value === '开启' ? t('settings.drive.enabled') : value === '关闭' ? t('settings.drive.disabled') : translateLegacy(localizeDrivePreviewLanguage(value, language.value));}
function rowValue(row: DrivePreviewRow, source: DriveChoice) {return row.changes.length === 1 ? previewValueLabel(row.changes[0][source]) : t('settings.drive.groupedContent', {count: row.changes.length});}
function rowChoice(row: DrivePreviewRow) {return driveRowChoice(row, choices.value);}
function chooseRow(row: DrivePreviewRow, choice: DriveChoice) {choices.value = chooseDriveRow(row, choice, choices.value);}
function chooseAll(choice: DriveChoice) {for (const row of conflictRows.value) chooseRow(row, choice);}
function toggleDetails() {detailsVisible.value = !detailsVisible.value; page.value = 1;}
function toggleAutomatic() {automaticVisible.value = !automaticVisible.value; page.value = 1;}
function selectMerge() {direction.value = 'merge'; step.value = 'review';}
function backToChoose() {step.value = 'choose'; direction.value = '';}
let alive = true;
async function perform(operation: () => Promise<void>, deletionOperation = false) {
  if (busy.value) return;
  busy.value = true; deleting.value = deletionOperation; error.value = ''; uploadUnverified.value = false;
  try {await operation();} catch (failure) {if (alive) {
    uploadUnverified.value = failure instanceof CloudBackupRequestError && failure.errorKey === 'settings.cloud.uploadUnverified';
    if (failure instanceof CloudBackupRequestError && (failure.errorKey === 'settings.cloud.e2ee.passphraseRequired' || failure.errorKey === 'settings.cloud.e2ee.wrongPassphrase')) {
      remoteRequiresUnlock.value = true;
      if (failure.errorKey === 'settings.cloud.e2ee.wrongPassphrase') {
        forceUnlockPrompt.value = true;
        unlockDraft.value = '';
        ephemeralReadyPassphrase.value = undefined;
      }
      void nextTick(() => unlockInputRef.value?.focus?.());
    }
    error.value = failure instanceof CloudBackupRequestError && failure.errorKey ? t(failure.errorKey, failure.params) : failure instanceof Error ? translateLegacy(failure.message) : translateLegacy('同步未完成，请重试');
  }}
  finally {if (alive) {busy.value = false; deleting.value = false;}}
}
function persistLearningPreference() {
  try {localStorage.setItem(learningPreferenceKey, JSON.stringify({...learningScope}));} catch { /* 本地偏好写入受限时仅保持当前页面有效。 */ }
  if (hasAutoSyncSupport.value && autoSyncState.value?.enabled) {
    void client.configureAutoSync!({learningScope: {...learningScope}}).then(next => {if (alive) autoSyncState.value = next;}).catch(() => undefined);
  }
}
function toggleLearningAll(value: boolean | string | number) {
  if (busy.value || previewVisible.value) return;
  const enabled = value === true;
  learningScope.includeVocabulary = enabled;
  learningScope.includePersonalCorrections = enabled;
  learningScope.includeReadingMaterials = enabled;
  if (!enabled) learningScope.includeVocabularyContext = false;
  persistLearningPreference();
}
function toggleVocabularyContext(value: boolean | string | number) {
  if (busy.value || previewVisible.value || !learningEnabled.value) return;
  learningScope.includeVocabularyContext = value === true;
  persistLearningPreference();
}
function buildPrepareOptions(): CloudBackupPrepareOptions | undefined {
  const options: CloudBackupPrepareOptions = {};
  if (hasAnyLearningSyncScope(learningScope)) options.learningScope = {...learningScope};
  if (hasPassphraseSupport.value) {
    options.keyMode = e2eeEnabled.value ? 'custom' : 'app';
    if (e2eeEnabled.value) {
      if (showEphemeralReadyBar.value && ephemeralReadyPassphrase.value) {
        activeEphemeralPassphrase.value = ephemeralReadyPassphrase.value;
        pendingPassphrasePersist.value = null;
        options.passphrase = ephemeralReadyPassphrase.value;
      } else if (showUnlockBar.value && unlockLengthValid.value) {
        activeEphemeralPassphrase.value = unlockDraft.value;
        pendingPassphrasePersist.value = {rememberScope: unlockRemember.value, passphrase: unlockDraft.value};
        options.passphrase = unlockDraft.value;
      } else {
        activeEphemeralPassphrase.value = undefined;
        pendingPassphrasePersist.value = null;
      }
    } else {
      activeEphemeralPassphrase.value = undefined;
      pendingPassphrasePersist.value = null;
    }
  } else {
    activeEphemeralPassphrase.value = undefined;
    pendingPassphrasePersist.value = null;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}
function buildCommitOptions(): CloudBackupCommitOptions | undefined {
  if (!hasPassphraseSupport.value) return undefined;
  if (e2eeEnabled.value) {
    return {
      keyMode: 'custom',
      ...(activeEphemeralPassphrase.value ? {passphrase: activeEphemeralPassphrase.value} : {}),
    };
  }
  return {keyMode: 'app'};
}
async function requestPreview() {
  const prepareOptions = buildPrepareOptions();
  const result = prepareOptions
    ? await client.prepare(includeSensitive.value, prepareOptions)
    : await client.prepare(includeSensitive.value);
  if (!alive) {await client.cancel(result.id); return;}
  preview.value = result;
  choices.value = Object.fromEntries(result.changes.filter(change => change.recommended).map(change => [change.id, change.recommended!]));
  direction.value = initialDriveDirection(result);
  if (result.hasRemote && result.canUpload !== false && result.includeSensitive !== result.remoteIncludesSensitive) direction.value = '';
  step.value = direction.value ? 'review' : 'choose';
  page.value = 1; detailsVisible.value = true; automaticVisible.value = true; previewVisible.value = true;
}
async function prepare() {
  if (hasPassphraseSupport.value && e2eeEnabled.value && !canSyncWithCustomPassphrase.value) {
    e2eeValidationError.value = unlockDraft.value.length > 0
      ? t('settings.cloud.e2ee.invalidPassphrase')
      : t('settings.cloud.e2ee.passphraseRequired');
    void nextTick(() => unlockInputRef.value?.focus?.());
    return;
  }
  e2eeValidationError.value = '';
  await perform(requestPreview);
}
function resetSetupDialog() {setupPassphrase.value = ''; setupConfirm.value = ''; setupAcknowledged.value = false; setupRemember.value = 'session';}
function clearE2eeTransient(resetUpgrade = false) {
  unlockDraft.value = ''; ephemeralReadyPassphrase.value = undefined; activeEphemeralPassphrase.value = undefined;
  pendingPassphrasePersist.value = null; remoteRequiresUnlock.value = false; forceUnlockPrompt.value = false; e2eeValidationError.value = '';
  if (resetUpgrade) justEnabledE2ee.value = false;
}
function toggleE2ee(value: boolean | string | number) {
  if (busy.value || previewVisible.value || e2eeSetupVisible.value || e2eeDisableVisible.value) return;
  if (value === true) {resetSetupDialog(); e2eeSetupVisible.value = true; return;}
  if (passphraseState.value?.mode !== 'custom') {clearE2eeTransient(); return;}
  e2eeDisableVisible.value = true;
}
function submitSetupOnEnter() {if (!busy.value && canSubmitSetup.value) void confirmSetupE2ee();}
async function confirmSetupE2ee() {
  if (!hasPassphraseSupport.value || !canSubmitSetup.value) return;
  const remember = setupRemember.value, pass = setupPassphrase.value;
  await perform(async () => {
    const next = await client.configurePassphrase!(remember === 'none' ? {mode: 'custom', rememberScope: 'none'} : {mode: 'custom', rememberScope: remember, passphrase: pass});
    if (!alive) return;
    passphraseState.value = next; clearE2eeTransient();
    ephemeralReadyPassphrase.value = remember === 'none' ? pass : undefined;
    justEnabledE2ee.value = true; e2eeSetupVisible.value = false; resetSetupDialog();
    ElMessage.success(t('settings.cloud.e2ee.saved'));
  });
}
async function confirmDisableE2ee() {
  if (!hasPassphraseSupport.value) return;
  await perform(async () => {
    const next = await client.configurePassphrase!({mode: 'app'});
    if (!alive) return;
    passphraseState.value = next; clearE2eeTransient(true); e2eeDisableVisible.value = false;
    ElMessage.success(t('settings.cloud.e2ee.saved'));
  });
}
function submitUnlockOnEnter() {
  if (busy.value || previewVisible.value || !unlockLengthValid.value) return;
  void (unlockRemember.value === 'none' ? prepare() : applyUnlock());
}
async function applyUnlock() {
  if (!hasPassphraseSupport.value || !unlockLengthValid.value || unlockRemember.value === 'none') return;
  await perform(async () => {
    const next = await client.configurePassphrase!({mode: 'custom', rememberScope: unlockRemember.value, passphrase: unlockDraft.value});
    if (!alive) return;
    passphraseState.value = next; clearE2eeTransient();
    ElMessage.success(t('settings.cloud.e2ee.saved'));
  });
}
function clearEphemeralPassphrase() {ephemeralReadyPassphrase.value = undefined; activeEphemeralPassphrase.value = undefined; justEnabledE2ee.value = false;}
async function switchStoredRetention(scope: 'session' | 'device') {
  if (!hasPassphraseSupport.value || !passphraseState.value?.hasStoredPassphrase || passphraseState.value.storageScope === scope) return;
  await perform(async () => {
    const next = await client.configurePassphrase!({mode: 'custom', rememberScope: scope});
    if (!alive) return;
    passphraseState.value = next; unlockRemember.value = next.storageScope === 'none' ? 'session' : next.storageScope;
    ElMessage.success(t('settings.cloud.e2ee.saved'));
  });
}
async function forgetStoredPassphrase() {
  if (!hasPassphraseSupport.value) return;
  await perform(async () => {
    const next = await client.clearPassphrase!();
    if (!alive) return;
    passphraseState.value = next; clearE2eeTransient(true);
    ElMessage.success(t('settings.cloud.e2ee.cleared'));
  });
}
async function toggleAutoSync(value: boolean | string | number) {
  if (!hasAutoSyncSupport.value) return;
  await perform(async () => {
    const next = await client.configureAutoSync!({
      enabled: value === true,
      includeSensitive: includeSensitive.value,
      learningScope: {...learningScope},
    });
    if (alive) autoSyncState.value = next;
  });
}
async function selectAutoSyncInterval(minutes: CloudAutoSyncIntervalMinutes) {
  if (!hasAutoSyncSupport.value || autoSyncState.value?.intervalMinutes === minutes) return;
  await perform(async () => {
    const next = await client.configureAutoSync!({intervalMinutes: minutes});
    if (alive) autoSyncState.value = next;
  });
}
async function runAutoSyncNow() {
  if (!hasAutoSyncSupport.value) return;
  await perform(async () => {
    const next = await client.runAutoSyncNow!();
    if (alive) {
      autoSyncState.value = next;
      status.value = await client.status();
    }
  });
}
async function requestDeletion() {
  deleteConfirmation.value = '';
  const result = await client.prepareDelete();
  if (!alive) {await client.cancel(result.id); return;}
  deletion.value = result; deleteDetailsVisible.value = false; deleteVisible.value = true;
}
async function prepareDeletion() {
  if (previewVisible.value || consentVisible.value || deleteVisible.value) return;
  await perform(requestDeletion, true);
}
async function changeDeletionAccount() {await perform(async () => {
  await client.cancel(deletion.value?.id);
  if (!alive) return;
  try {await requestDeletion();} catch (failure) {deleteVisible.value = false; throw failure;}
}, true);}
async function confirmDeletion() {
  if (!canConfirmDeletion.value || !deletion.value) return;
  const id = deletion.value.id;
  await perform(async () => {
    try {
      const result = await client.commitDelete(id);
      if (alive) {status.value = result; ElMessage.success(t(result.deleted ? 'settings.cloud.deleteSuccess' : 'settings.cloud.deleteAbsent'));}
    } finally {if (alive) deleteVisible.value = false;}
  }, true);
}
async function cancelDeletion() {
  await perform(async () => {
    try {await client.cancel(deletion.value?.id);}
    finally {if (alive) deleteVisible.value = false;}
  });
}
function toggleSensitive(value: boolean | string | number) {
  if (busy.value || previewVisible.value || deleteVisible.value) return;
  if (value === true) {riskAcknowledged.value = false; consentVisible.value = true;}
  else saveSensitivePreference(false);
}
function saveSensitivePreference(value: boolean): boolean {
  try {
    // 同步保存本机偏好，立即关闭设置页也不会丢失；不进入配置备份或由远端恢复。
    localStorage.setItem(sensitivePreferenceKey, String(value));
    includeSensitive.value = value;
    error.value = '';
    if (hasAutoSyncSupport.value && autoSyncState.value?.enabled) {
      void client.configureAutoSync!({includeSensitive: value}).then(next => {if (alive) autoSyncState.value = next;}).catch(() => undefined);
    }
    return true;
  } catch {error.value = t('settings.cloud.sensitiveSaveFailed'); return false;}
}
function handleSensitivePreferenceChange(event: StorageEvent) {
  if (event.storageArea === localStorage && (event.key === sensitivePreferenceKey || event.key === null)) {
    includeSensitive.value = event.newValue === 'true';
    if (hasAutoSyncSupport.value && autoSyncState.value?.enabled) {
      void client.configureAutoSync!({includeSensitive: includeSensitive.value}).then(next => {if (alive) autoSyncState.value = next;}).catch(() => undefined);
    }
  }
  if (event.storageArea === localStorage && (event.key === learningPreferenceKey || event.key === null)) {
    loadLearningPreference();
    if (hasAutoSyncSupport.value && autoSyncState.value?.enabled) {
      void client.configureAutoSync!({learningScope: {...learningScope}}).then(next => {if (alive) autoSyncState.value = next;}).catch(() => undefined);
    }
  }
}
function confirmSensitive() {
  if (!riskAcknowledged.value) return;
  if (saveSensitivePreference(true)) consentVisible.value = false;
  else {consentVisible.value = false; riskAcknowledged.value = false;}
}
async function switchAccount() {
  await perform(async () => {
    switchingAccount.value = true;
    try {
      await client.cancel(preview.value?.id);
      if (!alive) return;
      try {await requestPreview();} catch (failure) {previewVisible.value = false; throw failure;}
    } finally {if (alive) switchingAccount.value = false;}
  });
}
async function commit() {
  if (step.value !== 'review' || !canCommit.value || !preview.value || !direction.value) return;
  const selected = {id: preview.value.id, direction: direction.value, choices: {...choices.value}};
  const commitOptions = buildCommitOptions();
  await perform(async () => {
    if (!alive) return;
    try {
      const result = commitOptions
        ? await client.commit(selected.id, selected.direction, selected.choices, commitOptions)
        : await client.commit(selected.id, selected.direction, selected.choices);
      if (alive) {
        status.value = result;
        const persist = pendingPassphrasePersist.value;
        activeEphemeralPassphrase.value = undefined;
        pendingPassphrasePersist.value = null;
        if (hasPassphraseSupport.value && persist && (persist.rememberScope !== 'none' || passphraseState.value?.mode !== 'custom' || passphraseState.value.hasStoredPassphrase)) {
          const nextPassphrase = await client.configurePassphrase!(
            persist.rememberScope === 'none'
              ? {mode: 'custom', rememberScope: 'none'}
              : {mode: 'custom', rememberScope: persist.rememberScope, passphrase: persist.passphrase},
          );
          if (alive) passphraseState.value = nextPassphrase;
        }
        if (alive) {
          ephemeralReadyPassphrase.value = undefined;
          unlockDraft.value = '';
          remoteRequiresUnlock.value = false;
          forceUnlockPrompt.value = false;
          justEnabledE2ee.value = false;
        }
        ElMessage.success(t('settings.cloud.syncComplete', {provider: props.provider}));
      }
    } finally {if (alive) previewVisible.value = false;}
  });
}
async function cancelPreview() {
  await perform(async () => {
    try {await client.cancel(preview.value?.id);}
    finally {if (alive) previewVisible.value = false;}
  });
}
function clearPreview() {preview.value = null; choices.value = {}; direction.value = ''; activeEphemeralPassphrase.value = undefined; pendingPassphrasePersist.value = null;}
function endSession() {if (preview.value || deletion.value || busy.value) void client.cancel(preview.value?.id ?? deletion.value?.id).catch(() => undefined);}
async function refreshStatus() {await perform(async () => {
  try {
    const [nextStatus, nextPassphrase, nextAutoSync] = await Promise.all([
      client.status(),
      hasPassphraseSupport.value ? client.passphraseStatus!() : Promise.resolve(null),
      hasAutoSyncSupport.value ? client.autoSyncStatus!() : Promise.resolve(null),
    ]);
    if (!alive) return;
    status.value = nextStatus;
    if (nextPassphrase) {
      passphraseState.value = nextPassphrase;
      remoteRequiresUnlock.value = false;
      forceUnlockPrompt.value = false;
      if (nextPassphrase.mode === 'custom' && nextPassphrase.hasStoredPassphrase) {
        unlockRemember.value = nextPassphrase.storageScope;
        ephemeralReadyPassphrase.value = undefined;
      } else if (nextPassphrase.mode === 'app') {
        unlockRemember.value = 'session';
        ephemeralReadyPassphrase.value = undefined;
        justEnabledE2ee.value = false;
      }
      if (!nextPassphrase.hasStoredPassphrase) unlockDraft.value = '';
    }
    if (nextAutoSync) autoSyncState.value = nextAutoSync;
  }
  catch (failure) {status.value = {available: false, reason: t('settings.cloud.unavailable'), account: null, lastSyncedAt: null}; throw failure;}
});}
defineExpose({refreshStatus});
onMounted(() => {window.addEventListener('storage', handleSensitivePreferenceChange); void refreshStatus();});
onUnmounted(() => {window.removeEventListener('storage', handleSensitivePreferenceChange); alive = false; setupPassphrase.value = ''; setupConfirm.value = ''; unlockDraft.value = ''; ephemeralReadyPassphrase.value = undefined; endSession(); clearPreview();});
</script>

<style scoped>
:global(.fluentread-cloud-sync-dialog) {display:flex; flex-direction:column; max-height:calc(100dvh - 32px); margin:16px auto;}
:global(.fluentread-cloud-sync-dialog .el-dialog__body) {overflow-y:auto; min-height:0; padding-top:8px; padding-bottom:24px;}
:global(.fluentread-cloud-sync-dialog .el-dialog__header), :global(.fluentread-cloud-sync-dialog .el-dialog__footer) {flex-shrink:0;}
:global(.fluentread-cloud-sync-dialog .el-dialog__title) {font-size:18px; font-weight:600;}
:global(.fluentread-cloud-sync-dialog .el-dialog__footer) {border-top:1px solid var(--el-border-color-lighter); padding-top:16px;}
:global(.fluentread-cloud-sync-dialog.cloud-compact-dialog .el-dialog__body) {padding-bottom:16px;}
.drive-sync {color:var(--el-text-color-primary);}
.cloud-scope {border:1px solid var(--el-border-color-lighter); border-radius:10px; padding:16px; background:var(--el-fill-color-blank);}
.cloud-scope-option {display:flex; gap:16px; align-items:center;}
.cloud-scope-option+.cloud-scope-option {margin-top:12px; padding-top:12px; border-top:1px solid var(--el-border-color-lighter);}
.cloud-scope-suboption {padding-inline-start:16px;}
.cloud-scope-option>label {display:grid; gap:5px; flex:1; min-width:0; cursor:pointer;}
.cloud-scope-option:first-child>label {cursor:default;}
.cloud-scope-option strong {font-size:13px; font-weight:500;}
.cloud-scope-option label>span {font-size:12px; line-height:1.7; color:var(--el-text-color-secondary); overflow-wrap:anywhere;}
.cloud-scope-option>.el-switch {flex-shrink:0;}
.e2ee,.cloud-autosync {margin-top:16px; border:1px solid var(--el-border-color-lighter); border-radius:10px; padding:16px; background:var(--el-fill-color-blank);}
.e2ee-row>label {cursor:pointer;}
.e2ee-title {display:inline-flex; flex-wrap:wrap; align-items:center; gap:8px;}
.e2ee-badge {font-size:11px; font-weight:500; padding:1px 8px; border-radius:999px; background:var(--el-fill-color-light); color:var(--el-text-color-secondary); line-height:1.6;}
.e2ee-badge.is-unlocked {background:var(--el-color-success-light-9); color:var(--el-color-success);}
.e2ee-badge.is-ready {background:var(--el-color-primary-light-9); color:var(--el-color-primary);}
.e2ee-badge.is-locked {background:var(--el-color-warning-light-9); color:var(--el-color-warning);}
.e2ee-sub {display:grid; gap:10px; margin-top:12px; padding-top:12px; border-top:1px solid var(--el-border-color-lighter);}
.e2ee-bar,.e2ee-fb {display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px 12px;}
.e2ee-ret,.e2ee-meter {display:flex; flex-wrap:wrap; align-items:center; gap:8px;}
.e2ee-lbl {font-size:12px; font-weight:500; color:var(--el-text-color-regular); white-space:nowrap;}
.seg {display:inline-flex; flex-wrap:wrap; padding:2px; gap:2px; border:1px solid var(--el-border-color-lighter); border-radius:8px; background:var(--el-fill-color-light);}
.seg-3 {display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); width:100%;}
.seg-btn {padding:5px 10px; border:1px solid transparent; border-radius:6px; background:transparent; color:var(--el-text-color-regular); font:inherit; font-size:12px; line-height:1.4; cursor:pointer;}
.seg-btn.is-active {border-color:var(--el-border-color-lighter); background:var(--el-bg-color); color:var(--el-color-primary); font-weight:500; box-shadow:0 1px 2px rgb(0 0 0 / 5%);}
.seg-btn:disabled {opacity:.6; cursor:not-allowed;}
.seg-btn:focus-visible {outline:2px solid var(--el-color-primary); outline-offset:1px;}
.e2ee-nudge {display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; margin:0; padding:8px 10px; border-radius:8px; background:var(--el-color-warning-light-9); font-size:12px; color:var(--el-text-color-regular);}
.e2ee-nudge .el-button {padding:0; min-height:auto; font-size:12px;}
.e2ee-muted,.e2ee-hint {margin:0; font-size:12px; line-height:1.6; color:var(--el-text-color-secondary);}
.e2ee-hint,.e2ee-ready {color:var(--el-text-color-regular);}
.e2ee-ready {display:flex; align-items:center; gap:6px; margin:0; font-size:12px; line-height:1.6;}
.e2ee-ready .el-icon {color:var(--el-color-success); font-size:15px; flex-shrink:0;}
.e2ee-unlock {display:flex; align-items:center; gap:8px;}
.e2ee-unlock :deep(.el-input),.e2ee-field :deep(.el-input) {flex:1; min-width:0; width:100%; max-width:none;}
.e2ee-unlock>.el-button,.cloud-autosync-controls>.el-button {flex-shrink:0; margin:0;}
.e2ee-form {display:grid; gap:14px;}
.e2ee-field {display:grid; gap:6px; min-width:0;}
.e2ee-field>label {font-size:13px; font-weight:500; color:var(--el-text-color-primary);}
.e2ee-bars {display:inline-flex; gap:3px; width:54px;}
.e2ee-bars>span {height:4px; flex:1; border-radius:999px; background:var(--el-border-color-lighter);}
.e2ee-bars.is-too-short>span:nth-child(1) {background:var(--el-color-danger); opacity:.5;}
.e2ee-bars.is-weak>span:nth-child(1) {background:var(--el-color-danger);}
.e2ee-bars.is-fair>span:nth-child(1),.e2ee-bars.is-fair>span:nth-child(2) {background:var(--el-color-warning);}
.e2ee-bars.is-strong>span {background:var(--el-color-success);}
.e2ee-str,.e2ee-err {margin:0; font-size:12px;}
.e2ee-str.is-too-short,.e2ee-str.is-weak,.e2ee-err {color:var(--el-color-danger);}
.e2ee-str.is-fair {color:var(--el-color-warning);}
.e2ee-str.is-strong {color:var(--el-color-success);}
.cloud-autosync-controls {display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin-top:12px; padding-top:12px; border-top:1px solid var(--el-border-color-lighter); font-size:12px;}
.cloud-autosync-status {margin:10px 0 0; font-size:12px; color:var(--el-text-color-secondary);}
.cloud-learning-preview {margin:0 0 20px; padding:12px 14px; border:1px solid var(--el-border-color-lighter); border-radius:8px; background:var(--el-fill-color-light);}
.cloud-learning-preview strong {display:block; font-size:13px; margin-bottom:8px;}
.cloud-learning-preview ul {list-style:none; margin:0; padding:0; display:grid; gap:6px;}
.cloud-learning-preview li {display:flex; flex-wrap:wrap; justify-content:space-between; gap:8px; font-size:12px; color:var(--el-text-color-regular);}
.cloud-preview-scope {flex-shrink:0; padding:3px 9px; border:1px solid var(--el-border-color-lighter); border-radius:999px; background:var(--el-bg-color); font-size:11px; line-height:1.6; color:var(--el-text-color-regular); cursor:help;}
.cloud-preview-scope strong {font-weight:600;}
.cloud-consent-intro {margin:0 0 14px; font-size:13px; line-height:1.7; color:var(--el-text-color-regular);}
.cloud-consent-risk {display:flex; align-items:flex-start; gap:8px; padding:12px; margin-bottom:16px; background:var(--el-fill-color-light); border-radius:8px;}
.cloud-consent-risk>.el-icon {color:var(--el-color-warning); font-size:16px; flex-shrink:0; margin-top:3px;}
.cloud-consent-risk p {margin:0; font-size:13px; line-height:1.7; color:var(--el-text-color-primary);}
.cloud-consent-checkbox {display:flex; align-items:flex-start; gap:8px; cursor:pointer; font-size:13px; line-height:1.7;}
.cloud-consent-checkbox input {accent-color:var(--el-color-primary); margin:4px 0 0; flex-shrink:0;}
.cloud-consent-actions {display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px;}
.cloud-consent-actions>.el-button {margin:0; max-width:100%; height:auto; min-height:32px; white-space:normal; line-height:1.5;}
.cloud-delete-entry {display:flex; justify-content:flex-end; padding-top:12px; margin-top:12px; border-top:1px solid var(--el-border-color-lighter);}
.cloud-delete-entry .el-icon {margin-inline-end:5px;}
.cloud-delete-entry :deep(.el-button:not(.is-disabled)), .cloud-delete-entry :deep(.el-button.is-loading) {color:#b54444;}
.cloud-delete-entry :deep(.el-button.is-loading::before) {background:transparent;}
:global(.dark .cloud-delete-entry .el-button:not(.is-disabled)), :global(.dark .cloud-delete-entry .el-button.is-loading) {color:var(--el-color-danger);}
.cloud-delete-account {display:flex; align-items:flex-start; gap:12px; margin-bottom:10px;}
.cloud-delete-target {flex:1; min-width:0; font-size:13px; line-height:1.7; overflow-wrap:anywhere;}
.cloud-delete-target strong {display:block; font-weight:600; color:var(--el-text-color-primary);}
.cloud-delete-target :deep(p) {margin:2px 0 0; overflow-wrap:anywhere; font-size:12px; line-height:1.7; color:var(--el-text-color-regular);}
.cloud-delete-account>.el-button {flex-shrink:0; padding:0; min-height:22px; margin:0; font-size:12px; color:var(--el-text-color-regular);}
.cloud-delete-description {font-size:13px; line-height:1.7; margin:0; color:var(--el-text-color-primary);}
.cloud-delete-impact {display:flex; gap:10px; padding:14px; border-radius:10px; background:var(--el-fill-color-light);}
.cloud-delete-impact>.el-icon {flex-shrink:0; font-size:18px; margin-top:2px; color:var(--el-color-danger);}
.cloud-delete-impact-content {min-width:0; flex:1;}
.cloud-delete-impact strong {font-size:14px; line-height:1.6; font-weight:600; color:var(--el-text-color-primary);}
.cloud-delete-impact p {margin:6px 0 0; font-size:12px; line-height:1.7; color:var(--el-text-color-regular);}
.cloud-delete-details {font-size:12px; line-height:1.7; color:var(--el-text-color-regular);}
:global(.fluentread-cloud-delete-help) {max-width:calc(100vw - 40px);}
.cloud-delete-footer {display:flex; align-items:center; flex-wrap:wrap; gap:8px 12px;}
.cloud-delete-footer>.cloud-consent-actions {margin-inline-start:auto;}
.cloud-delete-details-toggle {padding:4px 0; min-height:28px; font-size:12px; font-weight:400; color:var(--el-text-color-regular);}
.cloud-delete-details-toggle .el-icon {margin-inline-start:4px;}
.cloud-delete-details-toggle:focus-visible {outline:2px solid var(--el-color-primary); outline-offset:3px;}
.cloud-delete-note {font-size:12px; line-height:1.7; color:var(--el-text-color-regular); margin:0;}
.cloud-delete-note+.cloud-delete-note {margin-top:8px;}
.cloud-delete-verification {margin-top:12px;}
.cloud-delete-instruction {display:block; margin-top:12px; font-size:13px; line-height:1.9; color:var(--el-text-color-primary);}
.cloud-delete-instruction strong {padding:1px 5px; border-radius:4px; border:1px solid var(--el-border-color); background:var(--el-fill-color-light); font-size:14px; font-weight:700; white-space:nowrap;}
.cloud-delete-verification :deep(.el-input) {width:100%; max-width:none;}
.drive-heading {display:flex; justify-content:space-between; align-items:flex-start; gap:16px;}
.drive-heading h2 {margin:0; font-size:19px;}
.drive-boundary {color:var(--el-text-color-secondary); font-size:13px; line-height:1.7;}
.drive-badge {display:inline-flex; align-items:center; gap:5px; flex-shrink:0; white-space:nowrap; border-radius:20px; padding:4px 10px; font-size:12px; color:var(--el-text-color-secondary); background:var(--el-fill-color-light);}
.drive-badge svg {width:15px; height:15px; flex-shrink:0; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round;}
.drive-record {display:grid; gap:4px; flex:1 1 240px; min-width:0; margin-inline-start:auto; text-align:right;}
.drive-record p {margin:0; overflow-wrap:anywhere; font-size:13px; line-height:1.5;}
.drive-status {color:var(--el-text-color-secondary);}
.drive-change-details {font-size:12px; line-height:1.7; margin:0 0 12px; color:var(--el-text-color-secondary);}
.drive-error,.drive-actions {margin-top:16px;}
.drive-preview-notice {margin:0 0 24px; align-items:flex-start;}
.drive-preview-notice :deep(.el-alert__content) {min-width:0;}
.drive-preview-notice :deep(.el-alert__title) {display:block; line-height:1.7; overflow-wrap:anywhere;}
.drive-preview-notice :deep(.el-alert__icon) {margin-top:2px; flex-shrink:0;}
.drive-actions {display:flex; flex-wrap:wrap; align-items:center; gap:12px 20px;}
.drive-action-buttons {display:flex; flex-wrap:wrap; gap:12px; max-width:100%;}
.drive-action-buttons:empty {display:none;}
.drive-action-buttons>:deep(.el-button) {flex-shrink:0; max-width:100%; margin:0; min-height:32px; height:auto; white-space:normal; line-height:1.5; padding:8px 15px;}
.drive-account-bar {display:flex; align-items:center; flex-wrap:wrap; gap:8px 10px; border-radius:8px; background:var(--el-fill-color-light); padding:10px 12px; margin-bottom:20px;}
.drive-account-icon {font-size:18px; color:var(--el-text-color-secondary); flex-shrink:0;}
.drive-account-bar p {margin:0; flex:1 1 180px; min-width:0; font-size:12px; color:var(--el-text-color-regular); overflow-wrap:anywhere;}
.drive-account-bar .el-button {flex-shrink:0; font-size:12px; color:var(--el-text-color-secondary);}
.drive-steps {display:flex; gap:24px; list-style:none; padding:0 0 16px; margin:0 0 24px; border-bottom:1px solid var(--el-border-color-lighter);}
.drive-steps li {display:flex; align-items:center; gap:8px; font-size:12px; color:var(--el-text-color-secondary);}
.drive-steps li>span {display:grid; place-items:center; width:22px; height:22px; border-radius:50%; border:1px solid var(--el-border-color);}
.drive-steps li.is-current {color:var(--el-text-color-primary); font-weight:600;}
.drive-steps li.is-current>span {background:var(--el-color-primary); border-color:var(--el-color-primary); color:var(--el-color-white);}
.drive-intent-heading h3,.drive-review-title h3 {margin:0; font-size:20px; font-weight:600; color:var(--el-text-color-primary);}
.drive-intent-heading p,.drive-review-title p {margin:8px 0 0; font-size:13px; line-height:1.6; color:var(--el-text-color-secondary);}
.drive-operation-list {border:1px solid var(--el-border-color); border-radius:10px; overflow:hidden; margin-top:20px;}
.drive-operation {display:flex; align-items:flex-start; gap:12px; cursor:pointer; padding:20px; background:var(--el-bg-color);}
.drive-operation+.drive-operation {border-top:1px solid var(--el-border-color-lighter);}
.drive-operation>span {display:grid; gap:7px; min-width:0; flex:1;}
.drive-operation strong {color:var(--el-text-color-primary); font-size:15px; font-weight:600;}
.drive-operation span span {color:var(--el-text-color-secondary); font-size:13px; line-height:1.6;}
.drive-operation input {accent-color:var(--el-color-primary); margin:4px 0 0; flex-shrink:0;}
.drive-operation.is-selected {background:var(--el-color-primary-light-9);}
.drive-operation:focus-within {outline:2px solid var(--el-color-primary); outline-offset:-2px;}
.drive-advanced {display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; border-top:1px solid var(--el-border-color-lighter); padding-top:16px; margin-top:24px;}
.drive-advanced p {margin:0; color:var(--el-text-color-secondary); font-size:12px;}
.drive-advanced .el-button {color:var(--el-text-color-regular); font-size:13px;}
.drive-advanced .el-icon {margin:0 5px;}
.drive-review-title {display:flex; align-items:center; gap:14px; margin-bottom:12px;}
.drive-review-meta {display:flex; align-items:center; flex-wrap:wrap; gap:4px 12px;}
.drive-review-route {display:inline-flex; align-items:center; gap:6px; color:var(--el-text-color-regular);}
.drive-review-icon {display:grid; place-items:center; width:44px; height:44px; border-radius:12px; background:var(--el-color-primary-light-9); color:var(--el-color-primary); font-size:24px; flex-shrink:0;}
.drive-impact {margin:0 0 20px; font-size:12px; line-height:1.7; color:var(--el-text-color-secondary);}
.drive-summary {display:flex; gap:12px; padding:20px; border-radius:10px; background:var(--el-fill-color-light); margin:20px 0 12px;}
.drive-summary h3 {margin:0; font-size:18px; color:var(--el-text-color-primary);}
.drive-summary p {margin:8px 0 0; font-size:13px; line-height:1.6; color:var(--el-text-color-secondary);}
.drive-summary-positive {background:var(--el-color-success-light-9);}
.drive-summary-positive>.el-icon {font-size:24px; color:var(--el-color-success); flex-shrink:0;}
.drive-review-heading {display:flex; justify-content:space-between; align-items:center; gap:12px; border-top:1px solid var(--el-border-color-lighter); padding-top:20px; margin-top:20px;}
.drive-review-heading h3 {margin:0; font-size:15px; font-weight:600; color:var(--el-text-color-primary);}
.drive-review-heading p {margin:6px 0 0; font-size:13px; color:var(--el-text-color-secondary);}
.drive-bulk-actions {display:flex; flex-wrap:wrap; gap:6px;}
.drive-bulk-actions .el-button {margin:0;}
.drive-merge-ready {display:flex; align-items:center; gap:8px; padding:14px; font-size:13px; background:var(--el-color-success-light-9); border-radius:8px; color:var(--el-text-color-primary);}
.drive-merge-ready>.el-icon {font-size:18px; color:var(--el-color-success);}
.drive-details-toggle {display:flex; align-items:center; justify-content:space-between; gap:12px; width:100%; margin:16px 0 0; padding:14px; font:inherit; font-size:13px; text-align:left; line-height:1.5; color:var(--el-text-color-regular); background:var(--el-bg-color); border:1px solid var(--el-border-color); border-radius:8px; cursor:pointer;}
.drive-details-toggle:focus-visible {outline:2px solid var(--el-color-primary); outline-offset:2px;}
.drive-private-hint {font-size:12px; color:var(--el-text-color-secondary); line-height:1.6; margin:14px 0;}
.drive-differences {border:1px solid var(--el-border-color-lighter); border-radius:10px; overflow:hidden; margin-bottom:12px;}
.drive-change {padding:16px; border-bottom:1px solid var(--el-border-color-lighter);}
.drive-change:last-child {border-bottom:0;}
.drive-change-heading {display:flex; justify-content:space-between; gap:10px; align-items:center; margin-bottom:10px; font-size:13px;}
.drive-change-heading>span {font-size:12px; color:var(--el-color-success);}
.drive-change-heading>span.is-pending {color:var(--el-color-warning);}
.drive-change.is-compact {display:grid; grid-template-columns:minmax(120px, 220px) minmax(0, 1fr); align-items:baseline; gap:4px 16px; padding:12px 16px;}
.drive-change.is-compact .drive-change-heading {margin:0;}
.drive-change.is-compact .drive-change-details {grid-column:1 / -1; grid-row:2; margin:0;}
.drive-change-flow {display:flex; align-items:baseline; flex-wrap:wrap; gap:4px 8px; margin:0; font-size:13px; line-height:1.6; overflow-wrap:anywhere;}
.drive-change-flow .el-icon {align-self:center; font-size:12px; color:var(--el-text-color-secondary);}
.drive-change-from,.drive-change-to {display:inline-flex; align-items:baseline; flex-wrap:wrap; gap:2px 6px; min-width:0;}
.drive-change-flow small {flex:none; font-size:11px; font-weight:400; color:var(--el-text-color-placeholder);}
.drive-change-from {color:var(--el-text-color-secondary);}
.drive-change-to {color:var(--el-text-color-primary); font-weight:500;}
.drive-values {display:grid; grid-template-columns:1fr 1fr; gap:10px; overflow-wrap:anywhere;}
.drive-value {display:flex; align-items:flex-start; gap:8px; border:1px solid var(--el-border-color-lighter); border-radius:8px; padding:12px; font-size:13px;}
.drive-value.is-selected {border-color:var(--el-color-primary); background:var(--el-color-primary-light-9);}
.drive-value:focus-within {outline:2px solid var(--el-color-primary); outline-offset:2px;}
label.drive-value {cursor:pointer;}
.drive-value input {accent-color:var(--el-color-primary); margin:3px 0; flex-shrink:0;}
.drive-value>span {display:grid; gap:5px; min-width:0;}
.drive-value strong {font-size:12px; color:var(--el-text-color-secondary); font-weight:500;}
.drive-value span span {line-height:1.5; color:var(--el-text-color-primary);}
.drive-footer-hint {margin:0 0 12px; color:var(--el-text-color-secondary); font-size:12px; text-align:left;}
.drive-footer-row {display:flex; align-items:center; justify-content:space-between; gap:16px;}
.drive-footer-row>.el-button {margin:0; color:var(--el-text-color-secondary); font-size:13px;}
.drive-footer-row>.el-button .el-icon {margin-right:5px;}
.drive-footer-actions {display:flex; justify-content:flex-end; gap:8px; margin-left:auto;}
.drive-footer-actions .el-button {margin:0; min-height:38px;}
.is-disabled {cursor:wait; opacity:.65;}
@media (max-width:600px) {
  .seg-3 {grid-template-columns:1fr;}
  .e2ee-unlock {flex-direction:column; align-items:stretch;}
  .drive-heading {flex-wrap:wrap;}.drive-values {grid-template-columns:1fr;}.drive-change.is-compact {grid-template-columns:minmax(0, 1fr);}
  .drive-actions {flex-direction:column; align-items:flex-start;}.drive-record {flex:none; width:100%; margin-inline-start:0; text-align:left;}
  .drive-operation {padding:16px;}.drive-review-heading {align-items:flex-start; flex-direction:column;}
  .drive-account-bar {align-items:flex-start;}.drive-account-icon {display:none;}.drive-review-title h3 {font-size:18px;}
  .drive-footer-row {flex-wrap:wrap; gap:12px;}.drive-footer-row>.el-button {width:100%; justify-content:flex-start;}
  .drive-footer-actions {display:grid; grid-template-columns:1fr 1fr; width:100%;}
  .drive-footer-actions .el-button {height:auto; white-space:normal; line-height:1.5; padding:8px;}
  .drive-change {padding:12px;}.drive-steps {gap:16px;}
}
</style>
