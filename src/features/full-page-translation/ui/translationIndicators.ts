/**
 * @file src/features/full-page-translation/ui/translationIndicators.ts
 * 文件职责：创建全文翻译过程中插入原页面的加载指示器和失败重试提示，并将错误详情转换为页面通知或可操作的重试控件。
 * 主要内容：提供加载与失败控件，隔离宿主导航并保留键盘操作；冷却时点按重试显示剩余时间，不给每段译文创建计时器。受信 man7 段的反馈独占一行，受控重试由队列接管后清理旧反馈。
 * 模块边界：本文件不发起翻译、不判断候选，也不持有 session；重试回调由 runtime 注入，节点生命周期由 state 管理，全局页面通知通过 page-notice 公共接口显示。
 */
// 全文翻译节点中的加载与失败反馈。
import {showPageNotice} from '@/src/features/page-notice/public';
import {options} from '@/src/core/config/catalog';
import {getCustomOpenAIProviderLabel} from '@/src/core/config/customOpenAI';
import {getCompositeTranslationProvider} from '@/src/core/config/compositeTranslation';
import {config} from '@/src/services/config/store';
import {getTranslationErrorMessage} from '@/src/features/full-page-translation/core/errorMessage';
import {
  clearTranslationFailedHost,
  markTranslationFailedHost,
} from '@/src/features/full-page-translation/core/hostMarkers';
import {normalizeUiLanguage, translate} from '@/src/core/i18n';
import type {Diagnostic} from '@/src/services/diagnostics';
import {isPreparedManpageParagraph} from '@/src/core/translation/manpage';
import {
  createTranslationLoadingIndicator,
  shouldAnimateTranslationLoading,
} from '@/src/ui/translationLoadingIndicator';

// 图标只接收包内路径数据，不把 SVG 字符串交给 HTML 解析器。
const iconPaths = {
  retry: 'M35.9387 5.48805C35.9166 4.60421 35.2434 4.04719 34.279 4.0675C33.3131 4.0878 32.8154 4.67712 32.6567 5.56132C32.5745 6.01985 32.601 6.49957 32.5962 6.96997C32.5881 7.77251 32.594 8.5752 32.594 9.3779C32.4685 9.43478 32.343 9.4917 32.2175 9.54866C31.7961 9.14366 31.3817 8.73102 30.9521 8.33488C27.0799 4.76502 22.4856 3.43605 17.3405 4.22591C10.0761 5.34107 4.69388 11.3891 4.06231 18.939C3.46983 26.0213 8.03881 32.8643 14.897 35.1663C21.8348 37.495 29.5543 34.7845 33.4563 28.6429C33.7074 28.2475 33.9685 27.8417 34.1218 27.4045C34.4194 26.5555 34.2699 25.765 33.4312 25.3113C32.6231 24.8743 31.8573 25.0498 31.2835 25.7915C30.9966 26.1625 30.7785 26.5856 30.5106 26.9724C28.0914 30.4658 24.7682 32.3693 20.5158 32.5766C14.8218 32.8541 9.60215 29.1608 7.94272 23.717C6.22884 18.0946 8.59939 12.0366 13.6698 9.08126C18.5986 6.20837 24.9262 7.03281 28.9148 11.0837C29.2069 11.3803 29.4036 11.7708 29.8772 12.4519C28.32 12.4519 27.1212 12.3885 25.9323 12.4704C24.8345 12.5461 24.253 13.1995 24.262 14.1166C24.2708 15.0096 24.8931 15.7485 25.9495 15.7745C28.7068 15.8424 31.4671 15.8177 34.2259 15.7884C35.1348 15.7787 35.8872 15.2584 35.9148 14.3603C36.0054 11.4048 36.0127 8.44397 35.9387 5.48805Z',
  warn: 'M20.5607 2.5191C10.735 2.05516 2.46528 10.1045 2.50011 20.0984C2.54469 32.8837 15.9794 41.3025 27.521 35.772C28.0597 35.5138 28.6042 35.2357 29.0745 34.8742C29.9064 34.2347 30.0797 33.3404 29.5712 32.5989C29.0382 31.8217 28.2936 31.6838 27.4596 32.0227C27.2265 32.1174 27.0066 32.2437 26.7865 32.3701C26.6008 32.4767 26.415 32.5833 26.2211 32.6712C20.8005 35.1282 15.6165 34.6504 11.0342 30.8857C6.38506 27.0662 4.83815 21.9885 6.36608 16.1605C8.23236 9.04216 15.6457 4.59129 22.7912 6.13629C30.3201 7.76418 35.1917 14.6886 33.9006 22.1467C33.6763 23.4426 33.1697 24.693 32.665 25.9388C32.4936 26.3618 32.3223 26.7846 32.1625 27.2081C31.7321 28.3488 31.8755 29.1499 32.727 29.6338C33.5625 30.1085 34.3839 29.8271 35.0848 28.8121C35.2031 28.6407 35.3005 28.4544 35.3977 28.2685C35.4242 28.2179 35.4507 28.1672 35.4776 28.1169C36.5263 26.154 37.166 24.0544 37.3992 21.8528C38.4715 11.7296 30.8594 3.00541 20.5607 2.5191ZM22.2324 19.4482C22.6221 17.6294 21.6934 16.7853 19.8682 17.1885C19.4795 17.2744 19.0887 17.3789 18.7223 17.531C17.5055 18.036 17.1067 18.9307 17.8422 20.0563C18.3665 20.8586 18.2472 21.5161 18.0255 22.2965L17.9039 22.7239C17.5079 24.1148 17.1115 25.5072 16.7935 26.9165C16.4841 28.2873 17.2241 29.1723 18.6198 29.1593C18.6749 29.1502 18.7366 29.1408 18.8028 29.1307C18.9623 29.1063 19.1482 29.078 19.332 29.0394C21.5543 28.5732 21.9094 27.8227 20.9844 25.759C20.8192 25.3904 20.8406 24.873 20.9389 24.4633C21.1123 23.7404 21.3092 23.0227 21.5061 22.3052C21.7664 21.3567 22.0267 20.4083 22.2324 19.4482ZM21.2918 10.7674C22.3383 10.7322 23.3464 11.7297 23.3245 12.7787C23.3035 13.7817 22.4311 14.6541 21.4139 14.6892C20.3685 14.7252 19.5018 13.9485 19.4202 12.9025C19.3341 11.798 20.2055 10.8041 21.2918 10.7674Z',
};

const INTERACTIVE_HOST_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="treeitem"]',
].join(',');

/** 手册相邻说明段共用 PRE 的行内流；反馈独占一行，避免短暂挤动下一段首字。 */
function containManpageFeedback(node: HTMLElement, feedback: HTMLElement): HTMLElement {
  if (!isPreparedManpageParagraph(node)) return feedback;
  const block = node.ownerDocument.createElement('span');
  block.className = 'fluent-read-manpage-feedback';
  block.setAttribute('data-fr-translation-owned', 'true');
  block.style.setProperty('display', 'block', 'important');
  block.appendChild(feedback);
  return block;
}

// 插入失败提示并处理错误
export function insertFailedTip(
  node: HTMLElement,
  errMsg: string,
  onRetry: () => boolean | void,
  cooldown?: {remainingMs: () => number; code: 'rate-limit' | 'provider'},
): HTMLElement {
  const contextInvalidated = isExtensionContextInvalidated(errMsg);
  const keyboardAccessible = node.closest(INTERACTIVE_HOST_SELECTOR) === null;
  // 创建包装元素
  const wrapper = document.createElement("span");
  wrapper.classList.add("fluent-read-retry-wrapper");
  wrapper.setAttribute("data-fr-translation-owned", "true");
  const feedback = containManpageFeedback(node, wrapper);
  wrapper.setAttribute("role", "group");
  const language = normalizeUiLanguage(config.uiLanguage);
  wrapper.setAttribute("aria-label", translate('content.translationFailedActions', language));
  wrapper.addEventListener("click", blockHostLinkActivation);
  wrapper.addEventListener("auxclick", blockHostLinkActivation);

  // 创建重试按钮
  const retryBtn = createActionElement(
    translate('content.retry', language),
    'fluent-read-retry',
    iconPaths.retry,
    contextInvalidated
      ? handleInvalidatedRetryClick(errMsg)
      : handleRetryClick(node, feedback, onRetry, cooldown),
    keyboardAccessible,
  );

  // 添加失败标记：只写 data 属性，宿主 class 保持原样，避免站点按 class 改变原文排版。
  markTranslationFailedHost(node);

  // 创建错误信息提示按钮
  const errorTip = createActionElement(
    translate('content.errorReason', language),
    'fluent-read-reason',
    iconPaths.warn,
    handleErrorClick(errMsg),
    keyboardAccessible,
  );

  // 将所有元素批量添加到 wrapper
  wrapper.append(retryBtn, errorTip);
  node.appendChild(feedback);
  return feedback;
}

function isExtensionContextInvalidated(message: string): boolean {
  return message.toLowerCase().includes('extension context invalidated');
}

// 失败控件可能位于宿主 <a> 内；任何未命中具体按钮的点击也不能触发链接默认行为。
function blockHostLinkActivation(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

function createActionElement(
  label: string,
  className: string,
  pathData: string,
  onClick: (event: MouseEvent) => void,
  keyboardAccessible: boolean,
): HTMLElement {
  const action = document.createElement('span');
  action.classList.add('fluent-read-failure-action', className);

  const actionIcon = createIconElement(pathData);
  actionIcon.classList.add('fluent-read-action-icon');
  const actionLabel = document.createElement('span');
  actionLabel.classList.add('fluent-read-action-label');
  actionLabel.textContent = label;
  action.append(actionIcon, actionLabel);
  action.addEventListener('click', onClick);
  if (keyboardAccessible) {
    action.setAttribute('role', 'button');
    action.setAttribute('tabindex', '0');
    action.setAttribute('aria-label', label);
    action.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      action.click();
    });
  }
  return action;
}

// 处理重试按钮点击事件
export function showTranslationRetryWait(diagnostic?: Pick<Diagnostic, 'code' | 'retryAfterMs'>): boolean {
  const {code, retryAfterMs} = diagnostic ?? {};
  if (!retryAfterMs || (code !== 'rate-limit' && code !== 'provider')) return false;
  const language = normalizeUiLanguage(config.uiLanguage);
  const label = translate(`diagnostics.${code}.summary`, language);
  const wait = translate('diagnostics.action.retryCountdown', language, {seconds: Math.ceil(retryAfterMs / 1000)});
  showPageNotice(`${label} · ${wait}`, 'error', {key: 'fluent-read-translation-retry-wait'});
  return true;
}

function handleRetryClick(node: HTMLElement, wrapper: HTMLElement, onRetry: () => boolean | void,
  cooldown?: {remainingMs: () => number; code: 'rate-limit' | 'provider'}) {
  return (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (cooldown && showTranslationRetryWait({retryAfterMs: cooldown.remainingMs(), code: cooldown.code})) return;

    // boolean 回调由 runtime 持有状态和排队所有权；受限 drain 开始重试时再恢复旧 DOM。
    // 此处先删除 wrapper 会被 MutationObserver 当作宿主撤下失败 UI，取消刚接受的 pending。
    if (onRetry() !== undefined) return;
    wrapper.remove(); // 兼容不持有 runtime 状态的 void 回调。
    clearTranslationFailedHost(node); // 移除失败标记
  };
}

function handleInvalidatedRetryClick(errMsg: string) {
  return (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    showPageNotice(resolveErrorMessage(errMsg), 'error');
  };
}

// 处理错误提示按钮点击事件
function handleErrorClick(errMsg: string) {
  return (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    const message = resolveErrorMessage(errMsg);
    // 用户显式点击必须每次都有反馈；自动批量错误才使用节流通知。
    showPageNotice(message, 'error');
  };
}

// 根据错误信息返回错误提示
function resolveErrorMessage(errMsg: string): string {
  const service = options.services.find(({value}) => value === config.service);
  const label = service?.label
    || getCompositeTranslationProvider(config.compositeTranslationProviders, config.service)?.name
    || getCustomOpenAIProviderLabel(config.customOpenAIProviders, config.service);
  return getTranslationErrorMessage(errMsg, label);
}

// 创建图标元素
function createIconElement(pathData: string): HTMLElement {
  const iconElement = document.createElement("div");
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('height', '40');
  svg.setAttribute('width', '40');
  svg.style.cssText = 'display: inline; align-items: center; justify-content: center; width: 1em; height: 1em; margin-left: 1em; pointer-events: none;';
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', '#428ADF');
  path.setAttribute('d', pathData);
  svg.appendChild(path);
  iconElement.appendChild(svg);
  return iconElement;
}

// 插入加载动画
export function insertLoadingSpinner(
  node: HTMLElement,
  isCache: boolean = false
): HTMLElement {
  const spinner = createTranslationLoadingIndicator(node.ownerDocument, {
    style: config.translationLoadingStyle,
    animated: shouldAnimateTranslationLoading(
      config.animations !== false,
      node.ownerDocument.defaultView,
    ),
    cacheHit: isCache,
  });
  spinner.setAttribute("data-fr-translation-owned", "true");
  const feedback = containManpageFeedback(node, spinner);
  node.appendChild(feedback);
  return feedback;
}
