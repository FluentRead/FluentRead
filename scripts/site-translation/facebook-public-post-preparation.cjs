'use strict';
// 测试前置专用：只正常关闭已实测的 Facebook 中文登录推广，不改宿主 ARIA、账户或产品规则。
const {createHash} = require('node:crypto');
const verifiedPreparations = new WeakSet();
const verifiedPreparationPages = new WeakMap();

function isSupportedFacebookPublicPostUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.origin === 'https://www.facebook.com' && !url.username && !url.password &&
      /^\/[^/]+\/posts\/[^/]+(?:\/[^/]+)*\/?$/u.test(url.pathname);
  } catch {return false;}
}

function isVerifiedFacebookPublicPostPreparation(result, page) {
  return verifiedPreparations.has(result) && (arguments.length < 2 || verifiedPreparationPages.get(result) === page);
}

function freezeEvidence(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeEvidence(child);
    Object.freeze(value);
  }
  return value;
}

const FACEBOOK_PUBLIC_POST_SELECTORS = Object.freeze({
  message: '[data-ad-preview="message"][data-ad-comet-preview="message"]',
  dialog: '[role="dialog"][aria-modal="true"]:has(form#login_popup_cta_form)',
  close: '[role="dialog"][aria-modal="true"]:has(form#login_popup_cta_form) div[role="button"][aria-label="关闭"][tabindex="0"]:not([href]):not(form *)',
  readingDialog: '[role="dialog"][aria-modal="true"]:has([data-ad-preview="message"][data-ad-comet-preview="message"])',
  publicArticle: '[role="article"][aria-posinset="1"]',
});

// 仅等待原生帖子空壳完成 hydration；错误页面或已出现的歧义绝不当作加载中放行。
// 与最终准备检查一样，此回调必须能够独立序列化执行。
function readFacebookPublicPostHydrationInPage({expectedUrl}) {
  const reject = reason => {throw new Error('Facebook public post hydration refused: ' + reason);};
  let expected;
  try {expected = new URL(expectedUrl);} catch {reject('invalid public post URL');}
  if (expected.origin !== 'https://www.facebook.com' || !/^\/[^/]+\/posts\/[^/]+(?:\/[^/]+)*\/?$/u.test(expected.pathname) ||
      expected.username || expected.password || location.href !== expectedUrl) reject('exact public post URL changed or unsupported');
  if (document.querySelector('iframe[src*="captcha"],iframe[src*="challenges.cloudflare.com"],form[action*="checkpoint"],form[action*="captcha"],#challenge-running,#cf-challenge-running') ||
      /^(?:Just a moment|Verify you are human|Access Denied|Robot Check)/iu.test(document.title)) reject('authentication/challenge');
  const canonicals = [...document.querySelectorAll('link[rel="canonical"]')];
  if (canonicals.length > 1) reject('canonical public URL ambiguous');
  if (canonicals.length === 1) {
    let canonical;
    try {canonical = new URL(canonicals[0].getAttribute('href'), location.href).href;} catch {reject('canonical public URL mismatch');}
    if (!canonicals[0].hasAttribute('href') || canonical !== expectedUrl) reject('canonical public URL mismatch');
  }
  const messages = [...document.querySelectorAll('[data-ad-preview="message"][data-ad-comet-preview="message"]')];
  if (messages.length > 1) reject('public message ambiguous');
  const promotions = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]:has(form#login_popup_cta_form)')];
  if (promotions.length > 1) reject('promotion ambiguous');
  const message = messages[0], promotion = promotions[0];
  const postDialog = message?.closest('[role="dialog"][aria-modal="true"]');
  const allDialogs = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"]')];
  // 已观察到正文挂载前先出现带标题的帖子壳。它只授权继续等候，不授权正文或关闭动作。
  // 不能仅凭“空 dialog”放行：原生加载 article、唯一标题 IDREF 与独立推广必须同时成立。
  let loadingPostDialog;
  if (!message && canonicals.length === 1 && promotion && allDialogs.length === 2) {
    const candidate = allDialogs.find(node => node !== promotion);
    const articles = [...candidate.querySelectorAll('[role="article"]')];
    const headings = [...candidate.querySelectorAll('h2')];
    const ids = (candidate.getAttribute('aria-labelledby') || '').trim().split(/\s+/u).filter(Boolean);
    const labels = ids.length === 1 ? [...document.querySelectorAll('[id]')].filter(node => node.id === ids[0]) : [];
    const article = articles[0], heading = headings[0], label = labels[0];
    const status = article?.firstElementChild;
    const closes = [...candidate.querySelectorAll('[role="button"]')];
    const close = closes[0], scrollviews = [...document.querySelectorAll('#scrollview')];
    const owned = '[data-fr-translation-owned="true"],[data-fr-translation-segment="true"],.fluent-read-bilingual-content,.fluent-read-loading,.fluent-read-retry-wrapper';
    const text = node => (node?.textContent || '').replace(/\s+/gu, ' ').trim();
    if (candidate.localName === 'div' && candidate.getAttribute('role') === 'dialog' && candidate.getAttribute('aria-modal') === 'true' &&
        !candidate.contains(promotion) && !promotion.contains(candidate) && scrollviews.length === 1 &&
        scrollviews[0].getAttribute('aria-hidden') === 'true' && scrollviews[0].contains(candidate) && !scrollviews[0].contains(promotion) &&
        articles.length === 1 && !article.hasAttribute('aria-posinset') && article.closest('[role="dialog"]') === candidate &&
        !text(article) && article.children.length === 1 && status?.localName === 'div' && status.getAttribute('role') === 'status' &&
        status.getAttribute('data-visualcompletion') === 'loading-state' && status.getAttribute('aria-label') === '正在加载...' &&
        [...article.querySelectorAll('*')].every(node => node.localName === 'div' && (!node.hasAttribute('role') || node === status)) &&
        headings.length === 1 && heading.getAttribute('dir') === 'auto' && !article.contains(heading) && labels.length === 1 &&
        (label === heading || (label.localName === 'span' && label.parentElement === heading)) && text(label) &&
        text(candidate) === text(heading) && text(heading) === text(label) &&
        [...heading.querySelectorAll('*')].every(node => node.localName === 'span') &&
        closes.length === 1 && close.localName === 'div' && close.getAttribute('aria-label') === '关闭' && close.getAttribute('tabindex') === '0' &&
        close.closest('[role="dialog"]') === candidate && !article.contains(close) && !heading.contains(close) &&
        !candidate.closest(owned) && !candidate.querySelector(owned) &&
        !candidate.querySelector('a,[href],[role="link"],form,input,textarea,select,button,[contenteditable]:not([contenteditable="false" i]),iframe,object,embed,video,audio')) {
      loadingPostDialog = candidate;
    }
  }
  if (allDialogs.some(node => node !== promotion && node !== postDialog && node !== loadingPostDialog)) reject('unrecognized dialog');
  if (!message) return false;
  const article = message.closest('[role="article"][aria-posinset="1"]');
  if (!article || !postDialog || article.closest('[role="dialog"]') !== postDialog || promotion === postDialog ||
      promotion?.contains(message) || postDialog.contains(promotion)) reject('native public post/promotion relationship changed');
  return canonicals.length === 1 && Boolean(message.textContent.trim());
}

// 此函数直接序列化给 page.evaluate/waitForFunction，不能依赖模块作用域或 require。
function readFacebookPublicPostPreparationStateInPage({expectedUrl, afterDismissal = false}) {
  const reject = reason => {throw new Error('Facebook public post preparation refused: ' + reason);};
  let expected;
  try {expected = new URL(expectedUrl);} catch {reject('invalid public post URL');}
  if (expected.origin !== 'https://www.facebook.com' || !/^\/[^/]+\/posts\/[^/]+(?:\/[^/]+)*\/?$/u.test(expected.pathname) ||
      expected.username || expected.password || location.href !== expectedUrl) reject('exact public post URL changed or unsupported');
  if (document.querySelector('iframe[src*="captcha"],form[action*="checkpoint"]')) reject('authentication/challenge');
  const messageSelector = '[data-ad-preview="message"][data-ad-comet-preview="message"]';
  const dialogSelector = '[role="dialog"][aria-modal="true"]:has(form#login_popup_cta_form)';
  const closeSelector = '[role="dialog"][aria-modal="true"]:has(form#login_popup_cta_form) div[role="button"][aria-label="关闭"][tabindex="0"]:not([href]):not(form *)';
  const editorSelector = '[contenteditable]:not([contenteditable="false" i])';
  const owned = '[data-fr-translation-owned="true"],[data-fr-translation-segment="true"],.fluent-read-bilingual-content,.fluent-read-loading,.fluent-read-retry-wrapper';
  const messages = [...document.querySelectorAll(messageSelector)];
  const dialogs = [...document.querySelectorAll(dialogSelector)], closes = [...document.querySelectorAll(closeSelector)];
  if (messages.length !== 1 || !messages[0].textContent.trim()) reject('public message absent or ambiguous');
  if (dialogs.length > 1 || closes.length > 1) reject('promotion or close ambiguous');
  const message = messages[0], dialog = dialogs[0], close = closes[0];
  const postDialog = message.closest('[role="dialog"][aria-modal="true"]');
  const article = message.closest('[role="article"][aria-posinset="1"]');
  if (!postDialog || !article || article.closest('[role="dialog"]') !== postDialog || postDialog === dialog ||
      dialog?.contains(message) || postDialog.contains(dialog)) reject('native public post/promotion relationship changed');
  const readingDialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]:has([data-ad-preview="message"][data-ad-comet-preview="message"])')];
  if (readingDialogs.length !== 1 || readingDialogs[0] !== postDialog) reject('reading post dialog ambiguous');
  const allDialogs = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"]')];
  if (allDialogs.some(node => node !== dialog && node !== postDialog)) reject('unrecognized dialog');
  if ([message, dialog, postDialog, close].some(node => node?.closest(owned)) || message.querySelector(owned) || close?.querySelector(owned)) {
    reject('owned content is not native evidence');
  }
  if (message.closest('form,input,textarea,' + editorSelector) || message.querySelector('form,input,textarea,' + editorSelector)) {
    reject('public message contains an editor or account form');
  }
  const canonicals = [...document.querySelectorAll('link[rel="canonical"][href]')];
  if (canonicals.length !== 1 || new URL(canonicals[0].getAttribute('href'), location.href).href !== expectedUrl) reject('canonical public URL mismatch');
  const profile = expected.pathname.split('/')[1];
  const permalinks = [...article.querySelectorAll('a[role="link"][tabindex="0"][aria-label][href]')].filter(node => {
    if (message.contains(node) || node.closest('[role="article"]') !== article) return false;
    let url; try {url = new URL(node.getAttribute('href'), location.href);} catch {return false;}
    return url.origin === expected.origin && url.pathname.startsWith('/' + profile + '/posts/') &&
      /^\/[^/]+\/posts\/[^/]+(?:\/[^/]+)*\/?$/u.test(url.pathname) && !url.username && !url.password;
  });
  if (permalinks.length !== 1 || !permalinks[0].textContent.trim() || !permalinks[0].getAttribute('aria-label').trim() ||
      permalinks[0].closest(owned) || permalinks[0].querySelector(owned)) reject('native same-profile post permalink absent or ambiguous');
  const inaccessible = node => Boolean(node?.closest('[hidden],[inert],[aria-hidden="true"]'));
  const paint = node => {
    if (!node?.isConnected || inaccessible(node)) return false;
    const rect = node.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    for (let current = node; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  const textHit = node => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let text = walker.nextNode(); text; text = walker.nextNode()) {
      if (!text.textContent.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(text);
      for (const rect of range.getClientRects()) {
        const x = rect.x + Math.min(30, rect.width / 2), y = rect.y + rect.height / 2;
        if (rect.width <= 2 || rect.height <= 2 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const top = document.elementFromPoint(x, y);
        if (top && (top === node || node.contains(top))) return true;
      }
    }
    return false;
  };
  const promotionActive = Boolean(dialog && paint(dialog));
  const messageReadable = paint(message) && textHit(message);
  const readingPostScope = {
    dialogSelector: '[role="dialog"][aria-modal="true"]:has([data-ad-preview="message"][data-ad-comet-preview="message"])',
    messageSelector, publicArticleSelector: '[role="article"][aria-posinset="1"]',
    canonicalMatchesExpected: true, nativePermalinkCount: 1, sameProfilePostPermalink: true,
    messageCount: 1, separateNativePostDialog: true,
  };
  if (!promotionActive) {
    if (!messageReadable) {
      if (afterDismissal) return false;
      reject('public message unreadable without active known promotion');
    }
    return {action: 'none', urlUnchanged: true, promotionActive: false, messageReadable: true,
      knownDialogs: allDialogs.length, readingPostScope};
  }
  if (afterDismissal) return false;
  if (!close || close.localName !== 'div' || close.closest('[role="dialog"]') !== dialog || close.getAttribute('role') !== 'button' ||
      close.getAttribute('aria-label') !== '关闭' || close.getAttribute('tabindex') !== '0') reject('reviewed Chinese native close shape changed');
  const formAttributes = ['form', 'formaction', 'formmethod', 'formenctype', 'formtarget', 'formnovalidate', 'type'];
  if (close.closest('a,[href],[role="link"],form,button,' + editorSelector) || close.querySelector('a,[href],[role="link"],form,button,input,textarea,select,' + editorSelector) ||
      close.hasAttribute('data-fr-evidence-original-href') || formAttributes.some(name => close.hasAttribute(name) ||
        close.hasAttribute('data-fr-evidence-original-' + name))) reject('close has navigation/form capability');
  if (close.hasAttribute('disabled') || close.getAttribute('aria-disabled') === 'true' || !paint(close)) reject('close disabled or not painted/actionable');
  const rect = close.getBoundingClientRect(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  const top = document.elementFromPoint(x, y);
  if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || !top || (top !== close && !close.contains(top))) reject('native close is obstructed');
  const blockers = [];
  for (let current = message; current; current = current.parentElement) {
    if (current.hasAttribute('hidden') || current.hasAttribute('inert') || current.getAttribute('aria-hidden') === 'true') blockers.push(current);
  }
  if (blockers.length !== 1 || blockers[0].id !== 'scrollview' || blockers[0].hasAttribute('hidden') || blockers[0].hasAttribute('inert') ||
      !blockers[0].contains(postDialog) || blockers[0].contains(dialog)) reject('background post aria relationship changed');
  return {action: 'dismiss', urlUnchanged: true, promotionActive: true, messageReadable: false, knownDialogs: allDialogs.length,
    close: {tag: 'div', role: 'button', ariaLabel: '关闭', tabindex: '0', formAssociated: false, navigationCapable: false, painted: true, actualHit: true},
    backgroundPost: {nativeAriaHiddenRoot: 'scrollview', blockers: 1}, readingPostScope};
}

// 仅返回公有正文的完整 Text/BR 与原始 href 快照；调用层只保存摘要，不记录带查询参数的 href。
function readFacebookCaptionSnapshotInPage() {
  const roots = [...document.querySelectorAll('[data-ad-preview="message"][data-ad-comet-preview="message"]')];
  if (roots.length !== 1) throw new Error('Facebook public caption snapshot is absent or ambiguous');
  const root = roots[0], article = root.closest('[role="article"][aria-posinset="1"]');
  if (!article) throw new Error('Facebook public caption article is absent');
  const parts = [];
  const visit = node => {
    if (node.nodeType === 3) parts.push({type: 'text', text: node.textContent});
    else if (node.nodeType === 1 && node.localName === 'br') parts.push({type: 'br', text: '\n'});
    else for (const child of node.childNodes) visit(child);
  };
  visit(root);
  const links = [...root.querySelectorAll('a[href]')].map(node => ({text: node.textContent, href: node.getAttribute('href')}));
  const metadataLinks = [...article.querySelectorAll('a[role="link"][tabindex="0"][aria-label][href]')]
    .filter(node => !root.contains(node) && node.closest('[role="article"]') === article)
    .map(node => ({text: node.textContent, href: node.getAttribute('href'), ariaLabel: node.getAttribute('aria-label')}));
  return {parts, links, metadataLinks, canonical: [...document.querySelectorAll('link[rel="canonical"][href]')].map(node => node.getAttribute('href'))};
}

async function prepareFacebookPublicPost(page, expectedUrl, timeout, checkFocus = () => {}) {
  if (!isSupportedFacebookPublicPostUrl(expectedUrl)) throw new Error('Facebook preparation requires an exact HTTPS www.facebook.com public post URL');
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Facebook preparation requires a positive bounded timeout');
  const deadline = Date.now() + timeout;
  const remaining = () => {
    const value = deadline - Date.now();
    if (value <= 0) throw new Error('Facebook preparation deadline exceeded');
    return value;
  };
  const argument = {expectedUrl};
  let stage = 'hydration', before, after, nativeClicks = 0, nativeClickAttempts = 0, hydrationWaited = false;
  try {
    if (!await page.evaluate(readFacebookPublicPostHydrationInPage, argument)) {
      hydrationWaited = true;
      const hydrated = await page.waitForFunction(readFacebookPublicPostHydrationInPage, argument, {timeout: remaining(), polling: 100});
      await hydrated.dispose();
    }
    remaining();
    stage = 'preflight';
    before = await page.evaluate(readFacebookPublicPostPreparationStateInPage, argument);
    remaining();
    const sourceBefore = await page.evaluate(readFacebookCaptionSnapshotInPage);
    remaining();
    if (before.action === 'dismiss') {
      stage = 'pre-click-revalidation';
      const current = await page.evaluate(readFacebookPublicPostPreparationStateInPage, argument);
      if (current.action !== 'dismiss') throw new Error('Facebook native promotion changed before click; no click sent');
      const clickTimeout = remaining();
      stage = 'native-close'; nativeClickAttempts = 1;
      checkFocus(); await page.locator(FACEBOOK_PUBLIC_POST_SELECTORS.close).click({timeout: clickTimeout});
      nativeClicks = 1;
      if (page.url() !== expectedUrl) throw new Error('Facebook URL changed after normal native dismissal');
      stage = 'post-close-readiness';
      const ready = await page.waitForFunction(readFacebookPublicPostPreparationStateInPage,
        {...argument, afterDismissal: true}, {timeout: remaining(), polling: 100});
      await ready.dispose();
    }
    stage = 'caption-and-link-preservation';
    after = await page.evaluate(readFacebookPublicPostPreparationStateInPage, {...argument, afterDismissal: true});
    const sourceAfter = await page.evaluate(readFacebookCaptionSnapshotInPage);
    remaining();
    if (!after || after.action !== 'none' || page.url() !== expectedUrl || JSON.stringify(sourceBefore) !== JSON.stringify(sourceAfter)) {
      throw new Error('Facebook complete public caption/source links changed or remained unreadable');
    }
    const result = freezeEvidence({status: nativeClicks ? 'dismissed' : 'not-present', url: expectedUrl, nativeClicks, nativeClickAttempts, hydrationWaited, before, after,
      captionParts: sourceAfter.parts, captionLinkCount: sourceAfter.links.length,
      sourceAndLinkSnapshotSha256: createHash('sha256').update(JSON.stringify(sourceAfter)).digest('hex'),
      sourceAndLinksUnchanged: true, accountFormActions: 0, visibilityOrAriaWrites: 0, readingPostScope: after.readingPostScope});
    verifiedPreparations.add(result);
    verifiedPreparationPages.set(result, page);
    return result;
  } catch (error) {
    const details = {status: 'failed', stage, nativeClicks, nativeClickAttempts, hydrationWaited, before, after,
      accountFormActions: 0, visibilityOrAriaWrites: 0};
    // Keep the original failure object/stack; never retry, click again or turn a failed preparation into success.
    if (error && (typeof error === 'object' || typeof error === 'function') && Object.isExtensible(error)) error.facebookPreparation = details;
    throw error;
  }
}

module.exports = {FACEBOOK_PUBLIC_POST_SELECTORS, isSupportedFacebookPublicPostUrl, isVerifiedFacebookPublicPostPreparation,
  readFacebookPublicPostHydrationInPage, readFacebookPublicPostPreparationStateInPage, readFacebookCaptionSnapshotInPage, prepareFacebookPublicPost};
