'use strict';

// 只替换本次临时扩展 worker 的微软传输层；网页始终从真实站点加载。
// 用于稳定复现 DOM 生命周期，不提供供应商可用性、质量或时延证据。
// 此函数必须可独立序列化到 service worker；同一编解码器也供 Node 侧归属断言使用。
// UTF-8 每字节映射到 U+4E00…U+4EFF，输出逐字节绑定源文，而不是附加汉字掩盖原文回显。
// 这是测试占位文本，不是可读翻译；空白、行内槽、HTML 和实体保持传输协议原样。
function controlledProviderRuntime(installTransport = false) {
  const prefix = '测试译文：';
  const protocol = 'utf8-han-v1';
  const protectedToken = /__FRTERM_[a-z0-9_]+?__|___FLUENTREAD_(?:(?!___)[a-z0-9_-])+?_(?:0|[1-9]\d*)_(?:BEGIN|END)___|&lt;\/?[a-z][\s\S]*?&gt;|<\/?[a-z][^>]*>|&amp;(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);|&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);|\s+/giu;
  // Microsoft escapes every text slot before fetch. An escaped angle-bracket
  // sequence there is literal source text, not structural HTML: retain the
  // entities themselves but encode the letters between them.
  const microsoftEscapedTextToken = /__FRTERM_[a-z0-9_]+?__|___FLUENTREAD_(?:(?!___)[a-z0-9_-])+?_(?:0|[1-9]\d*)_(?:BEGIN|END)___|<\/?[a-z][^>]*>|&amp;(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);|&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);|\s+/giu;
  function encode(text, mode) {
    if (typeof text !== 'string') throw new TypeError('Controlled translation requires a string');
    if (!text.trim()) return text;
    const encoder = new TextEncoder();
    const encodeText = value => Array.from(encoder.encode(value), byte => String.fromCharCode(0x4e00 + byte)).join('');
    let translated = '', cursor = 0;
    for (const match of text.matchAll(mode === 'microsoft-escaped-text' ? microsoftEscapedTextToken : protectedToken)) {
      translated += encodeText(text.slice(cursor, match.index)) + match[0];
      cursor = match.index + match[0].length;
    }
    return prefix + translated + encodeText(text.slice(cursor));
  }
  function decodeText(text, acceptLiteral = () => false) {
    // 页面可合并多个逐槽响应，所有槽都必须被还原并参与完整原文比较。
    if (typeof text !== 'string' || !text.includes(prefix)) return null;
    const body = text.replaceAll(prefix, '');
    if (!/[\u4e00-\u4eff]/u.test(body)) return null;
    let decoded = '', cursor = 0;
    const decoder = new TextDecoder('utf-8', {fatal: true});
    const validLiteral = value => {
      const plain = value.replace(/&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/giu, '');
      return !/\p{L}/u.test(plain) || acceptLiteral(plain);
    };
    for (const match of body.matchAll(/[\u4e00-\u4eff]+/gu)) {
      const literal = body.slice(cursor, match.index);
      // DOM 字符与已核对的原样术语可保留；普通字词必须来自受控译文。
      if (!validLiteral(literal)) return null;
      try {
        decoded += literal + decoder.decode(Uint8Array.from(match[0], char => char.charCodeAt(0) - 0x4e00));
      } catch {return null;}
      cursor = match.index + match[0].length;
    }
    const literal = body.slice(cursor);
    if (!validLiteral(literal)) return null;
    return decoded + literal;
  }
  if (!installTransport) return {encode, decodeText};
  if (globalThis.__frCompatibilityTransport) {
    if (globalThis.__frCompatibilityTransport.protocol !== protocol) throw new Error('Controlled transport protocol changed in an existing worker');
    return;
  }
  const originalFetch = globalThis.fetch;
  const state = {protocol, requests: 0, texts: 0, active: 0};
  globalThis.__frCompatibilityTransport = state;
  globalThis.fetch = async (input, init) => {
    const address = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (address.hostname !== 'edge.microsoft.com' || address.pathname !== '/translate/translatetext') return originalFetch(input, init);
    state.requests += 1;
    state.active += 1;
    try {
      const texts = JSON.parse(init?.body ?? await input.text());
      if (!Array.isArray(texts) || texts.some(text => typeof text !== 'string')) throw new TypeError('Controlled translation requires a text array');
      const response = new Response(JSON.stringify(texts.map(text => ({translations: [{text: encode(text, 'microsoft-escaped-text')}]}))),
        {status: 200, headers: {'content-type': 'application/json'}});
      state.texts += texts.length;
      return response;
    } finally {state.active -= 1;}
  };
}

const {encode: encodeControlledTranslation, decodeText: decodeControlledTranslationText} = controlledProviderRuntime();

function isControlledTranslationForSource(output, source, sourceParts = [source]) {
  const inputs = [source, sourceParts.join(''), sourceParts.join(' ')];
  let allowedTerms;
  const decoded = decodeControlledTranslationText(output, literal => {
    const {hasOnlyCommonWebTerms, matchCommonWebTerms} = loadOriginalSlotPolicies();
    if (!hasOnlyCommonWebTerms(literal)) return false;
    allowedTerms ??= new Set(matchCommonWebTerms(inputs).map(term => term.source));
    return matchCommonWebTerms(literal).every(term => allowedTerms.has(term.source));
  });
  if (decoded === null) return false;
  const normalize = text => text.replace(/\s+/gu, ' ').trim();
  return inputs.some(input => normalize(input) === normalize(decoded));
}

// 页面证据只投影实际 DOM。保护子树通过原标签/文本/href 与译文骨架配对，
// 不能把未编码的普通正文当作成功；任何漏槽、换源或额外正文都会使完整比较失败。
function readControlledPageEvidenceInPage(options) {
  const artifact = '.fluent-read-bilingual-content,.fluent-read-loading,.fluent-read-retry-wrapper,[data-fr-translation-owned="true"]';
  const formulaSelector = 'math,mjx-container,.MathJax,.MathJax_Display,.MathJax_SVG,.MathJax_CHTML,.katex,.mwe-math-element,.ltx_Math';
  const protectedSelector = `code,pre,kbd,samp,var,time,[role="timer"],${formulaSelector},svg,[translate="no"],.notranslate,[data-notranslate="true"],sup.reference`;
  const omitted = 'script,style,noscript,template,[hidden],[inert],[aria-hidden="true"],.sr-only,.visually-hidden,[role="tooltip"],[contenteditable]:not([contenteditable="false"])';
  const formulaAuxiliary = '.MJX_Assistive_MathML,mjx-assistive-mml,.katex-mathml,annotation,annotation-xml';
  // A URL/domain alone in a real link is an identifier skeleton; arbitrary anchor prose is not.
  const linkIdentifier = /^(?:https?:\/\/\S+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[:/?#]\S*)?|\S+@\S+\.\S+|@[\p{L}\p{N}_-]+|u\/[\p{L}\p{N}_-]+|#[0-9]+)$/iu;
  // CNN's /20*/* glob permits * across slashes, exactly as the production compiler does.
  // These remain literal skeletons: neither a date nor a credit is omitted from evidence.
  const cnnArticle = ['http:', 'https:'].includes(globalThis.location?.protocol) &&
    ['www.cnn.com', 'edition.cnn.com'].includes(globalThis.location?.hostname) &&
    /^\/20[\s\S]*\/[\s\S]*$/u.test(globalThis.location?.pathname || '');
  // 与 amazon-shopping 的主机、* 路径 glob 及排除路径一致；价格和评分仍须逐项配对，不能省略损坏的原文骨架。
  const amazonPath = globalThis.location?.pathname || '';
  const amazonShopping = ['http:', 'https:'].includes(globalThis.location?.protocol) &&
    ['www.amazon.com', 'www.amazon.co.uk', 'www.amazon.de', 'www.amazon.co.jp'].includes(
      (globalThis.location?.hostname || '').toLowerCase().replace(/\.$/u, '')) &&
    /^(?:\/dp\/[\s\S]*|\/[\s\S]*\/dp\/[\s\S]*|\/gp\/product\/[\s\S]*|\/gp\/customer-reviews\/[\s\S]*)$/u.test(amazonPath) &&
    !/^\/(?:login|signin|signup|account|settings|checkout|auth)(?:\/|$)/u.test(amazonPath);
  const amazonProtected = amazonShopping ? '.a-price,#acrPopover' : '';
  // The production GitHub adapter explicitly protects these custom time elements without role=timer.
  const siteProtected = globalThis.location?.hostname === 'github.com' ? 'relative-time,time-ago,local-time'
    : cnnArticle ? '.byline__name,.timestamp__time-since,figcaption.image_large-elevate__credit,figcaption.image-elevate__credit' : amazonProtected;
  // 与生产 GitHub 原生 issue 身份组件一致；依赖连接中的 live 上下文匹配 main/timeline，
  // 只配对保留的标签/文本/href/linkHref 骨架，不省略源、译文或 Markdown 内同名正文。
  const githubMetadataProtected = globalThis.location?.hostname === 'github.com' ? [
    'main a[data-testid="issue-body-header-author"][data-hovercard-type="user"][href]:not(.markdown-body):not(.markdown-body *)',
    'main [data-testid="comment-header"]:not(.markdown-body):not(.markdown-body *):not(:has(.markdown-body))',
    'main #issue-timeline a[data-testid="actor-link"][href]:not(.markdown-body):not(.markdown-body *)',
  ].join(',') : '';
  // Match only the declared GitLab site profile paths; both sibling label spans
  // are protected by its production rule and must retain their link context.
  const gitlabPath = globalThis.location?.pathname || '';
  const gitlabProfile = ['http:', 'https:'].includes(globalThis.location?.protocol) &&
    (globalThis.location?.hostname || '').toLowerCase().replace(/\.$/u, '') === 'gitlab.com' &&
    /^\/.*\/-\/(?:(?:issues|work_items|merge_requests|blob|wikis)\/.*|releases.*)$/u.test(gitlabPath) &&
    !/^\/(?:login|signin|signup|account|settings|checkout|auth)(?:\/|$)/u.test(gitlabPath);
  const gitlabLabelProtected = gitlabProfile ? '.gl-label-text,.gl-label-text-scoped' : '';
  // Keep the ordinary source/partition projection unchanged. A separate per-read,
  // per-native-node marker lets GitLab labels participate in source/output order.
  const gitlabMarker = /[\uFFF2\uFFF3]/u;
  const gitlabMarkers = new WeakMap((gitlabLabelProtected
    ? [...document.querySelectorAll(gitlabLabelProtected)].filter(node => !node.closest(artifact)) : [])
    .map((node, index) => [node, `\uFFF2${index}\uFFF3`]));
  const ubuntuManpage = globalThis.location?.hostname === 'manpages.ubuntu.com' && /^\/manpages\/[^/]+\/man[0-9][^/]*\/[^/]+\.html$/u.test(globalThis.location?.pathname || '');
  // Match the SQLite documentation profile exactly; ordinary page buttons are not protected prose.
  const sqliteDocument = ['sqlite.org', 'www.sqlite.org'].includes(globalThis.location?.hostname) &&
    /^(?:\/lang.*|\/syntax\/.*|\/c3ref\/.*|\/docs\.html)$/u.test(globalThis.location?.pathname || '');
  // 与生产 Bing 正文规则的日期 omit 完全相同；普通日期 span 和其它页面仍参与完整源文比较。
  const bingOmitted = globalThis.location?.hostname === 'www.bing.com' && globalThis.location?.pathname === '/search'
    ? '#b_results > .b_algo .b_caption .news_dt' : '';
  // Steam 讨论标题明确 omit 此元数据；只投影原生标题下的标签，不删译文或放过多余输出。
  const steamDiscussion = ['http:', 'https:'].includes(globalThis.location?.protocol) &&
    globalThis.location?.hostname === 'steamcommunity.com' &&
    /^\/app\/\d+\/discussions\//u.test(globalThis.location?.pathname || '');
  const steamOmitted = steamDiscussion
    ? '#AppHubContent .forum_topics .forum_topic_name .forum_topic_label' : '';
  const siteOmitted = [bingOmitted, steamOmitted].filter(Boolean).join(',');
  const literalToken = /^[\w.+/-]+(?:(?:\s*,\s*[\w.+/-]+)+|(?:\s+--?\w[\w-]*)+)?$/u;
  const isProtected = (node, live) => node.matches(protectedSelector) || siteProtected && node.matches(siteProtected) ||
    githubMetadataProtected && live?.matches(githubMetadataProtected) ||
    gitlabLabelProtected && live?.matches(gitlabLabelProtected) ||
    sqliteDocument && node.matches('button') ||
    ubuntuManpage && live?.matches('#manpage-content section.Sh b,#manpage-content section.Sh i') && literalToken.test(node.textContent.trim()) ||
    node.matches('a[href]') && linkIdentifier.test(node.textContent.trim());
  const visibleFormulaText = node => {
    const copy = node.cloneNode(true);
    copy.querySelectorAll(formulaAuxiliary).forEach(child => child.remove());
    return copy.textContent;
  };
  const textNodes = (root, inheritedLink) => {
    const parts = [], walk = document.createTreeWalker(root, 1 | 4);
    while (walk.nextNode()) {
      const node = walk.currentNode;
      if (node.nodeType === 3) parts.push({text: node.nodeValue || '', linkHref: node.parentElement?.closest('a[href]')?.getAttribute('href') ?? inheritedLink});
      else if (node.localName === 'br') parts.push({text: '\n', linkHref: null});
    }
    return parts;
  };
  // Optional source partitions bind the complete native Text/BR corpus before
  // translation. They do not infer missing source from whichever owners rendered.
  const partitionRequest = options?.sourcePartition;
  const partitionKey = '__fluentReadControlledSourcePartitionsV1';
  const partitionArtifact = `${artifact},[data-fr-translation-segment="true"]`;
  const projectPartition = (root, excludeSelectors) => {
    const copy = root.cloneNode(true);
    const live = [...root.querySelectorAll('*')], clones = [...copy.querySelectorAll('*')];
    const contexts = new WeakMap(clones.map((node, index) => [node, live[index]]));
    live.forEach((node, index) => {
      if (node.closest(artifact)) return;
      let omit = node.matches(omitted) || excludeSelectors.some(selector => node.matches(selector));
      try {
        const style = node.ownerDocument.defaultView?.getComputedStyle?.(node);
        if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') omit = true;
        if (style && (style.position === 'absolute' || style.position === 'fixed') &&
            (style.overflow === 'hidden' || style.overflow === 'clip' || (style.overflowX === 'hidden' && style.overflowY === 'hidden'))) {
          const clip = style.clip?.replace(/[\s,]+/gu, ' ').trim();
          if ((/^rect\((0(?:px)?|1px) \1 \1 \1\)$/u.test(clip ?? '') || style.clipPath?.replace(/\s+/gu, '') === 'inset(50%)') &&
              /^(?:0(?:\.\d+)?|1(?:\.0+)?)px$/u.test(style.width) && /^(?:0(?:\.\d+)?|1(?:\.0+)?)px$/u.test(style.height)) omit = true;
        }
      } catch { /* Missing styles never exempt source text. */ }
      if (siteOmitted && node.matches(siteOmitted)) omit = true;
      if (omit) clones[index].remove();
    });
    copy.querySelectorAll(artifact).forEach(node => node.remove());
    copy.querySelectorAll('[data-fr-translation-segment="true"]').forEach(node => node.replaceWith(...node.childNodes));
    for (const node of copy.querySelectorAll('*')) {
      if (copy.contains(node) && isProtected(node, contexts.get(node))) node.remove();
    }
    return textNodes(copy, root.closest('a[href]')?.getAttribute('href') ?? null).map(part => part.text);
  };
  const partitionRows = (root, excludeSelectors, selector) => [...root.querySelectorAll(selector)].filter(node =>
    !excludeSelectors.some(excluded => [...root.querySelectorAll(excluded)].some(ancestor => ancestor.contains(node))));
  let partitionBindings;
  if (partitionRequest) {
    const ledgers = globalThis[partitionKey] ??= new Map();
    if (partitionRequest.operation === 'capture') {
      if (!Array.isArray(partitionRequest.configs) || !partitionRequest.configs.length) throw new Error('Source partitions require configurations');
      const records = partitionRequest.configs.flatMap(config => {
        const excludeSelectors = config.sourcePartition?.excludeSelectors ?? [];
        const indexed = Object.prototype.hasOwnProperty.call(config, 'index');
        if (indexed && (!Number.isSafeInteger(config.index) || config.index < 0)) {
          throw new Error('Source partition index must be a non-negative safe integer');
        }
        const roots = [...document.querySelectorAll(config.selector)];
        if (!roots.length) throw new Error(`Source partition container missing: ${config.selector}`);
        if (indexed && config.index >= roots.length) throw new Error(`Source partition index out of range: ${config.selector}/${config.index}`);
        // Hover supplies the resolved raw DOM index; full coverage omits index and
        // retains every native container. Keep the raw index for later identity checks.
        const selectedRoots = indexed ? [{root: roots[config.index], index: config.index}]
          : roots.map((root, index) => ({root, index}));
        return selectedRoots.map(({root, index}) => {
          if (excludeSelectors.some(selector => root.matches(selector))) throw new Error('Source partition excludes its entire container');
          if (root.matches(partitionArtifact) || partitionRows(root, excludeSelectors, partitionArtifact).length) {
            throw new Error('Source partition baseline already has translation artifacts');
          }
          const sourceParts = projectPartition(root, excludeSelectors);
          if (!sourceParts.join('').trim() || sourceParts.join('').includes('测试译文：')) throw new Error('Source partition baseline is not native source');
          return {name: config.name || config.selector, selector: config.selector, index, excludeSelectors,
            root: new WeakRef(root), sourceParts};
        });
      });
      ledgers.set(partitionRequest.id, records);
      if (ledgers.size > 128) ledgers.delete(ledgers.keys().next().value);
      return records.map(({root: _root, ...record}) => record);
    }
    partitionBindings = ledgers.get(partitionRequest.id);
    if (!partitionBindings) throw new Error('Source partition ledger unavailable');
  }
  const wrappers = [...document.querySelectorAll('.fluent-read-bilingual-content')];
  const evidence = wrappers.map((wrapper, index) => {
    const owner = wrapper.parentElement;
    const source = owner.cloneNode(true), translated = wrapper.cloneNode(true);
    // Visibility must come from connected source elements: cloning loses class-dependent CSS.
    // Formula descendants are special: aria-hidden often marks the visible layout copy.
    const liveElements = [...owner.querySelectorAll('*')], clonedElements = [...source.querySelectorAll('*')];
    const sourceContexts = new WeakMap(clonedElements.map((node, index) => [node, liveElements[index]]));
    const omittedParts = [];
    liveElements.forEach((node, position) => {
      if (node.closest(artifact) || node.parentElement?.closest(formulaSelector)) return;
      let reason = node.matches(omitted) ? 'explicit-hidden-or-nonprose' : '';
      try {
        const style = node.ownerDocument.defaultView?.getComputedStyle?.(node);
        if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') reason = 'computed-hidden';
        // Match the production snapshot's narrow accessibility-box contract. Neither
        // a familiar class, clipping alone, nor overflow on an ordinary prose box exempts text.
        if (style && (style.position === 'absolute' || style.position === 'fixed') &&
            (style.overflow === 'hidden' || style.overflow === 'clip' || (style.overflowX === 'hidden' && style.overflowY === 'hidden'))) {
          const clip = style.clip?.replace(/[\s,]+/gu, ' ').trim();
          if ((/^rect\((0(?:px)?|1px) \1 \1 \1\)$/u.test(clip ?? '') || style.clipPath?.replace(/\s+/gu, '') === 'inset(50%)') &&
              /^(?:0(?:\.\d+)?|1(?:\.0+)?)px$/u.test(style.width) && /^(?:0(?:\.\d+)?|1(?:\.0+)?)px$/u.test(style.height)) reason = 'computed-clipped-accessibility';
        }
      } catch { /* Unavailable styles cannot exempt visible source text. */ }
      if (siteOmitted && node.matches(siteOmitted)) reason = 'site-rule-omission';
      if (reason) {omittedParts.push({tag: node.localName, text: node.textContent, reason}); clonedElements[position].remove();}
    });
    source.querySelectorAll(artifact).forEach(node => node.remove());
    translated.querySelectorAll(artifact).forEach(node => node.remove());
    const hasGitlabLabels = Boolean(gitlabLabelProtected && [...source.querySelectorAll('*')].some(node => sourceContexts.get(node)?.matches(gitlabLabelProtected)));
    if (hasGitlabLabels && gitlabMarker.test(source.textContent + translated.textContent)) throw new Error('GitLab label marker collision');
    const protections = [];
    for (const node of source.querySelectorAll('*')) {
      if (!source.contains(node) || !isProtected(node, sourceContexts.get(node))) continue;
      // Only the outer protected subtree participates: nested MathML/KaTeX is one skeleton.
      const requireElement = Boolean(gitlabLabelProtected && sourceContexts.get(node)?.matches(gitlabLabelProtected));
      const marker = requireElement ? gitlabMarkers.get(sourceContexts.get(node)) : undefined;
      if (requireElement && !marker) throw new Error('GitLab native label marker unavailable');
      const elementOnly = Boolean(amazonProtected && node.matches(amazonProtected));
      protections.push({tag: node.localName, text: node.matches(formulaSelector) ? visibleFormulaText(node) : node.textContent, href: node.getAttribute('href'), linkHref: sourceContexts.get(node)?.closest('a[href]')?.getAttribute('href') ?? null, formula: node.matches(formulaSelector), ...(requireElement ? {requireElement: true, marker} : {}), ...(elementOnly ? {elementOnly: true} : {})});
      if (requireElement) node.replaceWith(document.createTextNode(marker)); else node.remove();
    }
    const protectedMatches = [];
    // GitLab scoped labels have ordered key/value siblings. Record original output
    // element order before removing matched subtrees, including duplicate texts.
    const outputOrder = new WeakMap([...translated.querySelectorAll('*')].map((node, index) => [node, index]));
    let lastGitlabLabelPosition = -1;
    const outputLink = node => node.closest('a[href]')?.getAttribute('href') ?? owner.closest('a[href]')?.getAttribute('href') ?? null;
    for (const part of protections) {
      let matched = !part.text.trim() && !part.elementOnly;
      for (const node of translated.querySelectorAll(part.tag)) {
        if ((part.formula ? visibleFormulaText(node) : node.textContent) === part.text && node.getAttribute('href') === part.href && outputLink(node) === part.linkHref) {
          const position = outputOrder.get(node);
          if (part.requireElement && (position === undefined || position <= lastGitlabLabelPosition)) continue;
          if (part.requireElement) lastGitlabLabelPosition = position;
          if (part.requireElement) node.replaceWith(document.createTextNode(part.marker)); else node.remove();
          matched = true; break;
        }
      }
      // Sanitization unwraps custom elements such as <relative-time role=timer>.
      // Only an entire unchanged Text node may match the observed protected subtree;
      // never remove an arbitrary substring or exempt an unmarked prose/date node.
      if (!matched && !part.requireElement && !part.elementOnly && part.href === null && !part.formula) {
        const walk = document.createTreeWalker(translated, 4);
        while (walk.nextNode()) {
          if (walk.currentNode.nodeValue === part.text && outputLink(walk.currentNode.parentElement) === part.linkHref) {walk.currentNode.remove(); matched = true; break;}
        }
      }
      protectedMatches.push({...part, matched});
    }
    const inheritedLink = owner.closest('a[href]')?.getAttribute('href') ?? null;
    const markedSourceNodes = textNodes(source, inheritedLink), markedOutputNodes = textNodes(translated, inheritedLink);
    // Only remove markers inserted for this owner; marker-shaped native text on
    // other sites or owners must remain part of the complete source comparison.
    const insertedMarkers = new Set(protections.filter(part => part.requireElement).map(part => part.marker));
    const sourceTextNodes = markedSourceNodes.filter(node => !insertedMarkers.has(node.text));
    const outputTextNodes = markedOutputNodes.filter(node => !insertedMarkers.has(node.text));
    const sourceParts = sourceTextNodes.map(node => node.text);
    const markedParts = markedSourceNodes.map(node => node.text);
    const gitlabOrderedProjection = hasGitlabLabels ? {source: markedParts.join(''), sourceParts: markedParts, output: markedOutputNodes.map(node => node.text).join(''), sourceTextNodes: markedSourceNodes, outputTextNodes: markedOutputNodes} : undefined;
    return {index, owner: owner.localName, source: sourceParts.join(''), sourceParts, output: outputTextNodes.map(node => node.text).join(''), sourceTextNodes, outputTextNodes, protectedMatches, omittedParts, sourceHtml: source.outerHTML.slice(0, 4000), ...(gitlabOrderedProjection ? {gitlabOrderedProjection} : {})};
  });
  if (!partitionBindings) return evidence;
  return partitionBindings.map(record => {
    const root = record.root.deref();
    if (!root?.isConnected || document.querySelectorAll(record.selector)[record.index] !== root) {
      throw new Error(`Source partition native container changed: ${record.selector}/${record.index}`);
    }
    const selected = new Set(partitionRows(root, record.excludeSelectors, '.fluent-read-bilingual-content'));
    return {name: record.name, selector: record.selector, index: record.index,
      sourceParts: projectPartition(root, record.excludeSelectors),
      artifacts: Number(root.matches(partitionArtifact)) + partitionRows(root, record.excludeSelectors, partitionArtifact).length,
      owners: evidence.filter((_row, index) => selected.has(wrappers[index]))};
  });
}

const sourcePartitionLedgers = new WeakMap();
async function captureSourcePartitions(page, configs) {
  const id = require('node:crypto').randomUUID();
  const expected = await page.evaluate(readControlledPageEvidenceInPage,
    {sourcePartition: {operation: 'capture', id, configs}});
  const ledger = Object.freeze({});
  sourcePartitionLedgers.set(ledger, {page, id, expected});
  return ledger;
}

async function assertSourcePartitions(page, ledger, phase, {restored = false} = {}) {
  const binding = ledger && sourcePartitionLedgers.get(ledger);
  if (!binding || binding.page !== page) throw new Error(`${phase}: source partition ledger does not belong to this page`);
  const current = await page.evaluate(readControlledPageEvidenceInPage,
    {sourcePartition: {operation: 'read', id: binding.id}});
  const normalize = text => text.replace(/\s+/gu, ' ').trim();
  const sameSource = (left, right) => [left.join(''), left.join(' ')].some(a =>
    [right.join(''), right.join(' ')].some(b => normalize(a) === normalize(b)));
  if (current.length !== binding.expected.length) throw new Error(`${phase}: source partition count changed`);
  return current.map((state, index) => {
    const expected = binding.expected[index];
    const label = `${phase}/${expected.selector}/${expected.index}`;
    if (restored && (state.artifacts !== 0 || state.owners.length !== 0)) {
      throw new Error(`${label}: restored partition still has translation artifacts`);
    }
    if (!sameSource(state.sourceParts, expected.sourceParts)) throw new Error(`${label}: complete native partition source changed`);
    if (!restored) {
      assertControlledPageEvidence(state.owners, label);
      const ownerParts = state.owners.flatMap(owner => owner.sourceParts);
      if (!sameSource(ownerParts, expected.sourceParts) || !['', ' '].some(separator =>
        isControlledTranslationForSource(state.owners.map(owner => owner.output).join(separator),
          expected.sourceParts.join(''), expected.sourceParts))) {
        throw new Error(`${label}: translation owners do not match complete partition source`);
      }
    }
    return {name: expected.name, selector: expected.selector, index: expected.index,
      sourcePartsCount: expected.sourceParts.length, expectedSource: expected.sourceParts.join(''),
      ownerCount: state.owners.length, completeSourceMatched: true, restored};
  });
}

let originalSlotPolicies;
function loadOriginalSlotPolicies() {
  if (originalSlotPolicies) return originalSlotPolicies;
  // Use the tested snapshot's actual pure eligibility rules; a second handwritten language
  // heuristic would either miss legitimate skipped slots or silently exempt foreign prose.
  const path = require('node:path'), {createRequire} = require('node:module');
  const root = path.resolve(__dirname, '../..');
  const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
  const built = esbuild.buildSync({stdin: {contents: `
    export {shouldSkipTranslationForTarget} from './src/core/language/detect';
    export {isNonTranslatableLiveData} from './src/core/translation/liveData';
    export {isIdentifierLikeText} from './src/core/translation/text';
    export {hasOnlyCommonWebTerms, matchCommonWebTerms} from './src/core/glossary/commonWebTerms';
  `, resolveDir: root}, alias: {'@': root}, bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent'});
  const policyModule = {exports: {}};
  require('node:vm').runInThisContext(`(function(require,module,exports){${built.outputFiles[0].text}\n})`, {filename: 'controlled-source-slot-policy.cjs'})(require, policyModule, policyModule.exports);
  originalSlotPolicies = policyModule.exports;
  return originalSlotPolicies;
}

function hasControlledTextNodeAttribution(row) {
  if (!Array.isArray(row.sourceTextNodes) || !Array.isArray(row.outputTextNodes)) return false;
  const policies = loadOriginalSlotPolicies(), sources = row.sourceTextNodes.map(node => node.text), outputs = row.outputTextNodes.map(node => node.text);
  // Evidence must describe precisely the same projected DOM text checked by the caller.
  if (sources.join('') !== row.source || outputs.join('') !== row.output || /[\uFFF0\uFFF1]/u.test(row.source + row.output)) return false;
  const matchedOutputs = new Set();
  row.sourceTextNodes.forEach((node, index) => {
    const text = node.text.trim();
    if (!text || text.includes('测试译文：')) return;
    const identifier = node.linkHref !== null && policies.isIdentifierLikeText(text);
    if (!identifier && !policies.isNonTranslatableLiveData(text) && !policies.shouldSkipTranslationForTarget(text, 'zh-Hans', [])) return;
    const target = row.outputTextNodes.findIndex((output, outputIndex) => !matchedOutputs.has(outputIndex) && output.text === node.text && (!identifier || output.linkHref === node.linkHref));
    if (target < 0) return;
    // An ordered, unique sentinel preserves adjacency and ordering in the final full-source
    // comparison. Only an entire exact DOM Text node can be paired, never a substring.
    const marker = `\uFFF0${index}\uFFF1`;
    sources[index] = marker;outputs[target] = marker;matchedOutputs.add(target);
  });
  return isControlledTranslationForSource(outputs.join(''), sources.join(''), sources);
}

function assertControlledPageEvidence(evidence, phase) {
  if (!Array.isArray(evidence) || !evidence.length) throw new Error(`${phase}: controlled response owners missing`);
  for (const row of evidence) {
    const marked = row.gitlabOrderedProjection;
    if (row.protectedMatches?.some(part => !part.matched) || (!isControlledTranslationForSource(row.output, row.source, row.sourceParts) && !hasControlledTextNodeAttribution(row)) ||
      (marked && !isControlledTranslationForSource(marked.output, marked.source, marked.sourceParts) && !hasControlledTextNodeAttribution(marked))) {
      throw new Error(`${phase}/${row.index}: controlled response not proven for complete source ${JSON.stringify(row)}`);
    }
  }
  return {protocol: 'utf8-han-v1', owners: evidence.length, completeSourceMatched: true};
}

async function installControlledProvider(context, createPage, timeout) {
  const install = worker => worker.evaluate(controlledProviderRuntime, true);
  const errors = [];
  const workers = new Set();
  const isExtensionWorker = target => /^chrome-extension:\/\/[^/]+\//u.test(target.url());
  const worker = context.serviceWorkers().find(isExtensionWorker) ||
    await context.waitForEvent('serviceworker', {timeout, predicate: isExtensionWorker});
  const extensionUrl = new URL(worker.url());
  if (extensionUrl.protocol !== 'chrome-extension:') throw new Error('Controlled transport requires an extension service worker');
  const extensionPrefix = `chrome-extension://${extensionUrl.host}/`;
  // 实站可注册自己的 http(s) worker。测试供应商只接管本次扩展的传输，不触碰网站脚本。
  const isOwnedWorker = target => target.url().startsWith(extensionPrefix);
  const onWorker = target => {
    if (!isOwnedWorker(target)) return;
    workers.add(target);
    void install(target).catch(error => errors.push(error.message));
  };
  context.on('serviceworker', onWorker);
  workers.add(worker);
  try {
    await install(worker);
    const popup = await createPage(context, timeout);
    try {
      await popup.goto(`${extensionPrefix}popup.html`, {waitUntil: 'domcontentloaded', timeout});
      const response = await popup.evaluate(async () => {
        const stored = await chrome.runtime.sendMessage({type: 'configStorageRead', key: 'local:config'});
        if (!stored.success) throw new Error(stored.error);
        const config = typeof stored.value === 'string' ? JSON.parse(stored.value) : stored.value;
        const updates = {service: 'microsoft', from: 'en', to: 'zh-Hans', display: 1, autoTranslate: false,
          hotkey: 'Control', floatingBallHotkey: 'Alt+T', fullPageTranslationMode: 'viewport',
          useCache: false, enableAIContext: false, enableAIMultiSegment: false,
          uiLanguage: 'zh-CN', uiLanguageSetupCompleted: true};
        return chrome.runtime.sendMessage({type: 'persistConfig', mode: 'patch', config: updates,
          expected: Object.fromEntries(Object.keys(updates).map(key => [key, config[key]])),
          clientId: 'web-compatibility-suite', sequence: 1, baseRevision: config.__fluentConfigRevision});
      });
      if (!response?.success) throw new Error(`Controlled-provider configuration failed: ${JSON.stringify(response)}`);
    } finally {await popup.close();}
  } catch (error) {context.off('serviceworker', onWorker); throw error;}
  return {
    captureSourcePartitions,
    assertSourcePartitions,
    async assertPage(page, phase) {
      return assertControlledPageEvidence(await page.evaluate(readControlledPageEvidenceInPage), phase);
    },
    async snapshot() {
      if (errors.length) throw new Error(`Controlled transport worker failed: ${errors.join('; ')}`);
      const currentWorkers = context.serviceWorkers().filter(isOwnedWorker);
      const current = currentWorkers[0];
      if (current !== worker || currentWorkers.length !== 1 || workers.size !== 1) throw new Error('Controlled transport worker changed or disappeared; response attribution is not proven');
      const state = await current.evaluate(() => globalThis.__frCompatibilityTransport);
      if (!state || state.protocol !== 'utf8-han-v1' || !Number.isSafeInteger(state.requests) || state.requests < 1 || !Number.isSafeInteger(state.texts) || state.texts < 1 || state.active !== 0) {
        throw new Error('Controlled transport has no completed request evidence or remains active');
      }
      return {mode: 'controlled-microsoft-response', scope: 'real-site DOM compatibility only',
        workerSelection: 'exact-extension-origin', workerCount: workers.size, ...state, errors};
    },
    dispose() {context.off('serviceworker', onWorker);},
  };
}

module.exports = {controlledProviderRuntime, installControlledProvider, encodeControlledTranslation, decodeControlledTranslationText, isControlledTranslationForSource, readControlledPageEvidenceInPage, assertControlledPageEvidence, captureSourcePartitions, assertSourcePartitions};
