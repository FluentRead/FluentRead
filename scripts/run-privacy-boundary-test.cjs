#!/usr/bin/env node

// 在临时 Chromium/Edge profile 中验证 FluentRead 的网页隐私边界：
// 1. 只迁移旧版 FluentRead 页面缓存，不触碰宿主站点 localStorage；
// 2. 网页伪造的配置/全文翻译事件和合成键盘事件不能驱动扩展；
// 3. 凭据不进入公开配置、宿主 DOM 或页面可访问的 Shadow DOM；
// 4. options 真实消息/UI 路径始终使用加密持久凭据、完整明文导出，并能在扩展运行时重载后恢复。

const {guardBrowserClose} = require('./testing/owned-browser-close.cjs');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');

const HOST_SENTINEL_KEY = 'host-sentinel';
const HOST_SENTINEL_VALUE = 'keep-host-data';
const HOST_PREFERENCE_KEY = 'host-preference';
const HOST_PREFERENCE_VALUE = 'keep-preference';
const LEGACY_CACHE_KEYS = [
  'flcache_service_model_private-paragraph',
  'flcache_reverse_private-translation',
];
const LEGACY_TIMESTAMP_KEY = 'flLastSessionTimestamp';
const PREFILL_SECRET_MARKER = 'fr-prefill-secret-must-not-persist-192';
const CREDENTIAL_SENTINEL_PREFIX = 'fr-api-key-lifecycle-sentinel-issue-192-';
const CREDENTIAL_FIELDS = [
  'token',
  'ak',
  'sk',
  'appid',
  'key',
  'youdaoAppKey',
  'youdaoAppSecret',
  'tencentSecretId',
  'tencentSecretKey',
  'extra',
];

function parseArgs(argv) {
  const args = {
    background: true,
    timeout: 45_000,
    browserPath: null,
    focusSafeHelper: process.env.FLUENTREAD_FOCUS_SAFE_HELPER || path.join(__dirname, 'testing/focus-safe-browser.cjs'),
    artifactsDir: path.join(os.tmpdir(), 'fluentread-privacy-boundary-evidence'),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--background') continue;
    if (token === '--headed') {
      args.background = false;
      continue;
    }
    if (!token.startsWith('--')) throw new Error(`无法识别参数：${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`参数缺少值：${token}`);
    args[key] = value;
    index += 1;
  }

  if (!args.extensionDir) throw new Error('必须传入 --extension-dir');
  if (!args.playwrightRoot) throw new Error('必须传入 --playwright-root');
  args.timeout = Number(args.timeout);
  if (!Number.isFinite(args.timeout) || args.timeout <= 0) throw new Error('--timeout 必须为正数');
  return args;
}

function loadPlaywright(playwrightRoot) {
  try {
    return require('playwright');
  } catch (localError) {
    if (!playwrightRoot) throw localError;
    const root = path.resolve(playwrightRoot);
    const loader = createRequire(path.join(root, '__fluentread_privacy_boundary_loader__.cjs'));
    return loader('playwright');
  }
}

function loadFocusSafeBrowser(helperPath) {
  if (!helperPath) {
    throw new Error('后台浏览器测试必须传入 --focus-safe-helper 或设置 FLUENTREAD_FOCUS_SAFE_HELPER');
  }
  const resolved = path.resolve(helperPath);
  if (!fs.existsSync(resolved)) throw new Error(`focus-safe helper 不存在：${resolved}`);
  const helper = require(resolved);
  if (typeof helper.launchFocusSafePersistentContext !== 'function'
    || typeof helper.newPageWithoutForeground !== 'function'
    || typeof helper.activateExtensionTabWithoutForeground !== 'function') {
    throw new Error(`focus-safe helper 缺少必要导出：${resolved}`);
  }
  return helper;
}

function resolveBrowserExecutable(configuredPath) {
  if (configuredPath) {
    const resolved = path.resolve(configuredPath);
    if (!fs.existsSync(resolved)) throw new Error(`浏览器不存在：${resolved}`);
    return resolved;
  }

  const candidates = [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
  ];
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error('没有找到 Edge/Chrome/Chromium；请传入 --browser-path');
  return executable;
}

function assertDedicatedTemporaryProfile(profileDir) {
  const resolved = path.resolve(profileDir);
  const temporaryRoot = path.resolve(os.tmpdir());
  const relativeToTemp = path.relative(temporaryRoot, resolved);
  if (relativeToTemp.startsWith('..') || path.isAbsolute(relativeToTemp)) {
    throw new Error(`profile 不在系统临时目录：${resolved}`);
  }

  const home = os.homedir();
  const forbidden = [
    path.join(home, 'Library/Application Support/Google/Chrome'),
    path.join(home, 'Library/Application Support/Microsoft Edge'),
    path.join(home, '.config/google-chrome'),
    path.join(home, '.config/microsoft-edge'),
  ];
  if (forbidden.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  })) {
    throw new Error(`拒绝使用日常浏览器 profile：${resolved}`);
  }
}

function readManifest(extensionDir) {
  const manifestPath = path.join(extensionDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`插件 manifest.json 不存在：${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const contentScriptFiles = (manifest.content_scripts || [])
    .flatMap((entry) => Array.isArray(entry.js) ? entry.js : [])
    .filter((file, index, files) => files.indexOf(file) === index);
  const contentSource = contentScriptFiles
    .map((file) => {
      const sourcePath = path.join(extensionDir, file);
      if (!fs.existsSync(sourcePath)) throw new Error(`manifest 引用的内容脚本不存在：${sourcePath}`);
      return fs.readFileSync(sourcePath, 'utf8');
    })
    .join('\n');

  const forbiddenControlLiterals = ['fluent:prefill', 'fluentread-toggle-translation'];
  const foundForbiddenControlLiterals = forbiddenControlLiterals.filter((literal) => contentSource.includes(literal));
  if (foundForbiddenControlLiterals.length > 0) {
    throw new Error(`production 内容脚本仍暴露网页控制事件：${foundForbiddenControlLiterals.join(', ')}`);
  }
  return {
    manifestPath,
    manifestVersion: manifest.manifest_version,
    optionsPage: manifest.options_ui?.page || manifest.options_page || 'options.html',
    contentScriptFiles,
    foundForbiddenControlLiterals,
  };
}

function fixtureHtml() {
  const initialStorage = {
    [HOST_SENTINEL_KEY]: HOST_SENTINEL_VALUE,
    [HOST_PREFERENCE_KEY]: HOST_PREFERENCE_VALUE,
    [LEGACY_CACHE_KEYS[0]]: '旧版译文',
    [LEGACY_CACHE_KEYS[1]]: '旧版原文',
    [LEGACY_TIMESTAMP_KEY]: '123456789',
  };
  const imageSvg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="100%" height="100%" fill="#dbeafe"/><text x="20" y="68" font-size="24" fill="#1e3a8a">Privacy fixture</text></svg>');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>FluentRead Privacy Boundary Fixture</title>
  <script>
    (() => {
      const entries = ${JSON.stringify(initialStorage)};
      for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
      window.__privacyBoundaryInitialStorage = Object.fromEntries(
        Array.from({length: localStorage.length}, (_, index) => localStorage.key(index))
          .filter(Boolean)
          .map((key) => [key, localStorage.getItem(key)]),
      );
    })();
  </script>
  <style>
    body { max-width: 820px; margin: 40px auto; padding: 0 24px; color: #172033; font: 18px/1.6 system-ui, sans-serif; }
    main { padding: 28px; border: 1px solid #dbe3ef; border-radius: 18px; background: #fff; box-shadow: 0 18px 50px rgba(15,23,42,.08); }
    img { display: block; width: 240px; height: 120px; margin-top: 24px; border-radius: 12px; }
  </style>
</head>
<body>
  <main>
    <h1>Host privacy sentinel</h1>
    <p id="privacy-target">This paragraph must remain untranslated after untrusted page events.</p>
    <img id="privacy-image" alt="Privacy fixture" src="data:image/svg+xml,${imageSvg}">
  </main>
</body>
</html>`;
}

async function startFixtureServer() {
  const html = fixtureHtml();
  const server = http.createServer((request, response) => {
    if (request.url === '/favicon.ico') {
      response.writeHead(204, { 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    if (request.url === '/' || request.url?.startsWith('/privacy-boundary')) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(html);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    const error = new Error('无法确定本地 fixture 端口');
    try {await closeServer(server);} catch (cleanupError) {process.stderr.write(`Fixture close failed: ${cleanupError.stack || cleanupError}\n`);}
    throw error;
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}/privacy-boundary.html`,
  };
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function storageObjectFromPage() {
  return Object.fromEntries(
    Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key) => typeof key === 'string')
      .map((key) => [key, localStorage.getItem(key)]),
  );
}

function safeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

function containsMarker(value, marker) {
  try {
    return JSON.stringify(value).includes(marker);
  } catch {
    return false;
  }
}

function hasCredentialFields(value) {
  return Boolean(value && typeof value === 'object' && CREDENTIAL_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(value, field)));
}

async function extensionStorageEvidence(extensionContext, marker, credentialMarker = null) {
  const snapshot = await extensionContext.evaluate(async () => {
    const requestResult = (request) => new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
    const database = await requestResult(indexedDB.open('FluentReadConfiguration'));
    let records;
    try {
      records = await requestResult(database.transaction('records', 'readonly').objectStore('records').getAll());
    } finally {
      database.close();
    }
    const readConfigRecord = (key) => new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'configStorageRead', key }, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message || 'config storage read failed'));
          return;
        }
        if (response?.success !== true) {
          reject(new Error(response?.error || `config storage read failed: ${key}`));
          return;
        }
        resolve(response.value ?? null);
      });
    });
    const local = await chrome.storage.local.get(null);
    const sessionSupported = Boolean(chrome.storage.session);
    const session = sessionSupported ? await chrome.storage.session.get(null) : {};
    const [config, history, backups, sessionCredentials, localCredentials, ocrLanguages] = await Promise.all([
      readConfigRecord('local:config'),
      readConfigRecord('local:configHistory'),
      readConfigRecord('local:configAutoBackups'),
      readConfigRecord('session:credentials'),
      readConfigRecord('local:credentials'),
      readConfigRecord('local:fluentReadImageOcrLanguages'),
    ]);
    return {
      local,
      session,
      sessionSupported,
      records,
      decrypted: { config, history, backups, sessionCredentials, localCredentials, ocrLanguages },
    };
  });
  const { config, history, backups, sessionCredentials, localCredentials, ocrLanguages } = snapshot.decrypted;
  const historyEntries = Array.isArray(history?.entries) ? history.entries : [];
  const localKeys = Object.keys(snapshot.local).sort();
  const sessionKeys = Object.keys(snapshot.session).sort();
  const recordKeys = snapshot.records.map((record) => record.key).sort();
  const legacyLocalKeys = [
    'config', 'local:config',
    'configHistory', 'local:configHistory',
    'configAutoBackups', 'local:configAutoBackups',
    'credentials', 'local:credentials',
    'fluentReadImageOcrLanguages', 'local:fluentReadImageOcrLanguages',
  ].filter((key) => localKeys.includes(key));
  const legacySessionKeys = ['credentials', 'session:credentials'].filter((key) => sessionKeys.includes(key));
  const decryptedRecords = snapshot.decrypted;
  return {
    localKeys,
    sessionKeys,
    sessionSupported: snapshot.sessionSupported,
    localContainsPrefillMarker: containsMarker(snapshot.local, marker),
    sessionContainsPrefillMarker: containsMarker(snapshot.session, marker),
    decryptedRecordsContainPrefillMarker: containsMarker(decryptedRecords, marker),
    rawIndexedDbContainsPrefillMarker: containsMarker(snapshot.records, marker),
    indexedDb: {
      databaseName: 'FluentReadConfiguration',
      recordKeys,
      encryptedEnvelopeCount: snapshot.records.length,
      recordsUseEncryptedEnvelope: snapshot.records.every((record) => (
        record?.payload?.format === 'fluentread-config'
          && record?.payload?.version === 1
          && record?.payload?.algorithm === 'AES-GCM'
          && typeof record?.payload?.iv === 'string'
          && typeof record?.payload?.ciphertext === 'string'
          && !Object.prototype.hasOwnProperty.call(record, 'value')
      )),
      legacyLocalKeys,
      legacySessionKeys,
    },
    configContainsCredentialFields: hasCredentialFields(config),
    historyContainsCredentialFields: historyEntries.some((entry) => hasCredentialFields(entry?.config)),
    credentialLifecycle: credentialMarker ? {
      publicConfigContainsSentinel: containsMarker(config, credentialMarker),
      publicHistoryContainsSentinel: containsMarker(history, credentialMarker),
      backupsContainSentinel: containsMarker(backups, credentialMarker),
      ocrLanguagesContainSentinel: containsMarker(ocrLanguages, credentialMarker),
      rawIndexedDbContainsSentinel: containsMarker(snapshot.records, credentialMarker),
      sessionCredentialsPresent: sessionCredentials !== null,
      sessionCredentialsContainsSentinel: containsMarker(sessionCredentials, credentialMarker),
      localCredentialsPresent: localCredentials !== null,
      localCredentialsContainsSentinel: containsMarker(localCredentials, credentialMarker),
    } : null,
    configProjection: config ? {
      on: config.on,
      autoTranslate: config.autoTranslate,
      disableFloatingBall: config.disableFloatingBall,
      selectionTranslatorMode: config.selectionTranslatorMode,
      disableSelectionTranslator: config.disableSelectionTranslator,
      selectionAreaEnabled: config.selectionAreaEnabled,
      disableImageTranslator: config.disableImageTranslator,
    } : null,
  };
}

function credentialStateMatches(storageEvidence, expected) {
  const state = storageEvidence.credentialLifecycle;
  return Boolean(state)
    && state.sessionCredentialsPresent === expected.sessionCredentialsPresent
    && state.sessionCredentialsContainsSentinel === expected.sessionCredentialsContainsSentinel
    && state.localCredentialsPresent === expected.localCredentialsPresent
    && state.localCredentialsContainsSentinel === expected.localCredentialsContainsSentinel;
}

async function waitForCredentialStorageState(extensionContext, marker, expected, timeout) {
  const deadline = Date.now() + timeout;
  let latest;
  while (Date.now() < deadline) {
    latest = await extensionStorageEvidence(extensionContext, PREFILL_SECRET_MARKER, marker);
    if (credentialStateMatches(latest, expected)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`等待凭据存储状态超时：${JSON.stringify({
    expected,
    actual: latest?.credentialLifecycle,
  })}`);
}

function assertCredentialStorageState(label, storageEvidence, expected) {
  if (!credentialStateMatches(storageEvidence, expected)) {
    throw new Error(`${label} 的凭据区域状态不符合预期：${JSON.stringify({
      expected,
      actual: storageEvidence.credentialLifecycle,
    })}`);
  }
  if (storageEvidence.credentialLifecycle.publicConfigContainsSentinel
    || storageEvidence.credentialLifecycle.publicHistoryContainsSentinel
    || storageEvidence.credentialLifecycle.backupsContainSentinel
    || storageEvidence.credentialLifecycle.ocrLanguagesContainSentinel
    || storageEvidence.credentialLifecycle.rawIndexedDbContainsSentinel
    || storageEvidence.configContainsCredentialFields
    || storageEvidence.historyContainsCredentialFields) {
    throw new Error(`${label} 时公开配置、备份或 IndexedDB 原始记录泄露了凭据`);
  }
  if (!storageEvidence.indexedDb.recordsUseEncryptedEnvelope
    || storageEvidence.indexedDb.legacyLocalKeys.length
    || storageEvidence.indexedDb.legacySessionKeys.length) {
    throw new Error(`${label} 时配置没有完全落入加密 IndexedDB：${JSON.stringify(storageEvidence.indexedDb)}`);
  }
  if (!storageEvidence.indexedDb.recordKeys.includes('local:credentials')
    || storageEvidence.indexedDb.recordKeys.includes('session:credentials')) {
    throw new Error(`${label} 时凭据没有形成唯一的本地持久记录：${JSON.stringify(storageEvidence.indexedDb.recordKeys)}`);
  }
}

async function configurePrivacySurfaces(optionsPage, clientId, timeout) {
  return optionsPage.evaluate(async ({ requestClientId, timeoutMs }) => {
    const parseConfig = (value) => {
      if (typeof value !== 'string') return value && typeof value === 'object' ? value : {};
      try {
        return JSON.parse(value);
      } catch {
        return {};
      }
    };
    const sendRuntimeMessage = (message) => new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (reply) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message || 'runtime message failed'));
          return;
        }
        resolve(reply);
      });
    });
    const readConfig = async () => {
      const response = await sendRuntimeMessage({ type: 'configStorageRead', key: 'local:config' });
      if (response?.success !== true) throw new Error(response?.error || 'background config read failed');
      return parseConfig(response.value);
    };
    const matchesExpectedSurfaces = (value) => value.on === true
      && value.autoTranslate === false
      && value.disableFloatingBall === false
      && value.selectionTranslatorMode === 'bilingual'
      && value.disableSelectionTranslator === false
      && value.selectionAreaEnabled === true
      && value.disableImageTranslator === false
      && !Object.prototype.hasOwnProperty.call(value, 'persistCredentials');

    const initializationDeadline = Date.now() + Math.min(timeoutMs, 10_000);
    let current = {};
    // options 页面完成挂载不代表 background 的 configReady 已经落下首次 revision；
    // 先等待公开快照，随后通过 persistConfig 进入与产品相同的串行写入队列。
    while (Date.now() < initializationDeadline) {
      current = await readConfig();
      if (Number.isSafeInteger(current.__fluentConfigRevision)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!Number.isSafeInteger(current.__fluentConfigRevision)) {
      throw new Error('background config initialization did not complete');
    }

    let response;
    // 只有明确的 revision 冲突可以用最新快照重试；其他后台错误必须原样暴露。
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const baseRevision = current.__fluentConfigRevision;
      response = await sendRuntimeMessage({
        type: 'persistConfig',
        config: {
          ...current,
          on: true,
          autoTranslate: false,
          floatingBallHotkey: 'Alt+T',
          disableFloatingBall: false,
          selectionTranslatorMode: 'bilingual',
          disableSelectionTranslator: false,
          selectionAreaEnabled: true,
          disableImageTranslator: false,
        },
        clientId: requestClientId,
        sequence: attempt,
        baseRevision,
      });
      if (response?.success === true) break;
      if (!String(response?.error || '').includes('配置已更新') || attempt === 3) {
        throw new Error(`background rejected privacy surface config: ${response?.error || 'unknown error'}`);
      }
      current = await readConfig();
      if (!Number.isSafeInteger(current.__fluentConfigRevision)) {
        throw new Error('background config revision disappeared during retry');
      }
    }
    if (response?.success !== true
      || !Number.isSafeInteger(response.revision)
      || response.revision < 0) {
      throw new Error('background did not acknowledge privacy surface config with a valid revision');
    }

    const writeDeadline = Date.now() + Math.min(timeoutMs, 10_000);
    let verified = {};
    while (Date.now() < writeDeadline) {
      verified = await readConfig();
      if (verified.__fluentConfigRevision >= response.revision && matchesExpectedSurfaces(verified)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (verified.__fluentConfigRevision < response.revision || !matchesExpectedSurfaces(verified)) {
      throw new Error('privacy surface config was not durably written');
    }
    return {
      saveTransport: 'chrome.runtime.sendMessage from options extension origin',
      saveAcknowledged: true,
      revision: response.revision,
      directWorkerStorageWriteUsed: false,
      on: verified.on,
      autoTranslate: verified.autoTranslate,
      disableFloatingBall: verified.disableFloatingBall,
      selectionTranslatorMode: verified.selectionTranslatorMode,
      disableSelectionTranslator: verified.disableSelectionTranslator,
      selectionAreaEnabled: verified.selectionAreaEnabled,
      disableImageTranslator: verified.disableImageTranslator,
    };
  }, { requestClientId: clientId, timeoutMs: timeout });
}

async function waitForExtensionWorker(context, timeout) {
  const existing = context.serviceWorkers().find((worker) => worker.url().startsWith('chrome-extension://'));
  if (existing) return existing;
  return context.waitForEvent('serviceworker', {
    timeout: Math.min(timeout, 30_000),
    predicate: (worker) => worker.url().startsWith('chrome-extension://'),
  });
}

async function waitForOptionsUi(page, timeout) {
  // 重载会保留上次打开的分类；备份与恢复断言需要回到数据分类。
  const dataNavigation = page.locator('button[data-section="settings-data"]');
  await dataNavigation.waitFor({ state: 'visible', timeout });
  if (!await page.locator('#settings-data').isVisible()) await dataNavigation.click();
  await page.waitForSelector('#settings-data', { state: 'visible', timeout });
  if (await page.locator('[data-testid="persist-credentials-switch"]').count()) {
    throw new Error('设置页仍显示已废弃的凭据持久化开关');
  }
  if ((await page.locator('#settings-data').textContent()).includes('跨浏览器重启保存 API 凭据')) {
    throw new Error('设置页仍显示已废弃的凭据持久化文案');
  }
  return true;
}

async function openOptionsPage(createPage, activatePage, extensionId, optionsPath, timeout) {
  const optionsUrl = new URL(optionsPath, `chrome-extension://${extensionId}/`);
  optionsUrl.hash = 'settings-data';
  const optionsPage = await createPage();
  await optionsPage.goto(optionsUrl.href, { waitUntil: 'domcontentloaded', timeout });
  await activatePage(optionsPage);
  await waitForOptionsUi(optionsPage, timeout);
  return optionsPage;
}

async function persistCredentialViaExtensionMessage(optionsPage, marker, clientId) {
  const result = await optionsPage.evaluate(async ({ credentialMarker, requestClientId }) => {
    const sendRuntimeMessage = (message) => new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (reply) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message || 'runtime message failed'));
          return;
        }
        resolve(reply);
      });
    });
    const stored = await sendRuntimeMessage({ type: 'configStorageRead', key: 'local:config' });
    if (stored?.success !== true) throw new Error(stored?.error || 'background config read failed');
    const current = stored.value && typeof stored.value === 'object' ? stored.value : {};
    const message = {
      type: 'persistConfig',
      config: {
        ...current,
        service: 'openai',
        token: {
          ...(current && typeof current.token === 'object' ? current.token : {}),
          openai: credentialMarker,
        },
      },
      clientId: requestClientId,
      sequence: 1,
    };
    const response = await sendRuntimeMessage(message);
    return { acknowledged: response?.success === true };
  }, { credentialMarker: marker, requestClientId: clientId });

  if (!result.acknowledged) throw new Error('后台未确认可信扩展页发出的凭据保存消息');
  return result;
}

async function waitForOptionsRuntimeCredential(optionsPage, marker, timeout) {
  // 设置页只渲染当前分类；凭据输入框位于翻译服务分类的默认服务配置中。
  await optionsPage.locator('button[data-section="settings-services"]').click();
  await optionsPage.waitForFunction((credentialMarker) => {
    // API Key 以多 Key 列表呈现；任一密码输入框回显该凭据即表示运行时已水合。
    return [...document.querySelectorAll('[data-service-configuration-service="openai"] input[type="password"]')]
      .some(input => input instanceof HTMLInputElement && input.value === credentialMarker);
  }, marker, { timeout });
  return true;
}

async function exportCompleteBackupViaOptionsUi(optionsPage, marker, timeout, artifactsDir) {
  // 真实设置页仅在用户明确点击后下载明文完整备份；默认选择不包含可能暴露浏览隐私的单词上下文。
  await optionsPage.locator('button[data-section="settings-data"]').click();
  await optionsPage.getByRole('button', { name: '导出备份', exact: true }).click();
  const contextDialog = optionsPage.locator('.el-message-box');
  await contextDialog.getByRole('checkbox', { name: /包含单词上下文/u }).waitFor({ state: 'visible', timeout });
  if (await contextDialog.getByRole('checkbox').isChecked()) throw new Error('完整备份的上下文选项必须默认关闭');
  const screenshotPath = path.join(artifactsDir, 'privacy-backup-context-dialog.png');
  await optionsPage.screenshot({ path: screenshotPath, fullPage: true });
  const [download] = await Promise.all([
    optionsPage.waitForEvent('download', { timeout }),
    contextDialog.getByRole('button', { name: '导出备份', exact: true }).click(),
  ]);
  const suggestedFilename = download.suggestedFilename();
  if (!/^fluentread-backup-\d{4}-\d{2}-\d{2}\.json$/u.test(suggestedFilename)) {
    throw new Error(`设置页完整备份文件名异常：${suggestedFilename}`);
  }
  const downloadPath = path.join(artifactsDir, 'privacy-complete-backup.json');
  await download.saveAs(downloadPath);
  const exported = fs.readFileSync(downloadPath, 'utf8');
  if (!exported.trim()) throw new Error('设置页导出的完整备份为空');

  let parsed;
  try {
    parsed = JSON.parse(exported);
  } catch {
    throw new Error('设置页导出的完整备份不是合法 JSON');
  }
  const config = parsed?.config;
  return {
    bytes: Buffer.byteLength(exported, 'utf8'),
    format: parsed?.format,
    version: parsed?.version,
    configCredentialMode: parsed?.configCredentialMode,
    service: config?.service,
    legacyPolicyFieldAbsent: !Object.prototype.hasOwnProperty.call(config || {}, 'persistCredentials'),
    containsCredentialSentinel: exported.includes(marker),
    containsCredentialFields: hasCredentialFields(config),
    includesPrivateVocabularyContext: parsed?.vocabulary?.includesPrivateContext,
    plaintextFile: true,
    suggestedFilename,
    download: downloadPath,
    screenshot: screenshotPath,
  };
}

async function pageBoundaryState(page, marker) {
  return page.evaluate(({ marker: secretMarker }) => {
    const storage = Object.fromEntries(
      Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
        .filter((key) => typeof key === 'string')
        .map((key) => [key, localStorage.getItem(key)]),
    );
    const extensionHosts = Array.from(document.querySelectorAll('[data-fluent-read-ui], [id^="fluent-read-"]'));
    return {
      storage,
      bilingualCount: document.querySelectorAll('.fluent-read-bilingual-content').length,
      loadingCount: document.querySelectorAll('.fluent-read-loading, .fluent-read-loading-spinner').length,
      retryCount: document.querySelectorAll('.fluent-read-retry-wrapper, .retry-error-wrapper').length,
      newApiContainerPresent: Boolean(document.querySelector('#fluent-new-api-container')),
      pageCanAccessChromeStorage: Boolean(globalThis.chrome?.storage),
      pageCanAccessBrowserStorage: Boolean(globalThis.browser?.storage),
      domContainsPrefillMarker: document.documentElement.outerHTML.includes(secretMarker),
      extensionHosts: extensionHosts.map((host) => ({
        id: host.id,
        ui: host.getAttribute('data-fluent-read-ui'),
        hasOpenShadowRoot: Boolean(host.shadowRoot),
      })),
      areaBoundary: (() => {
        const host = document.querySelector('#fluent-read-area-translator-container');
        return { present: Boolean(host), pageVisibleShadowRoot: Boolean(host?.shadowRoot) };
      })(),
      floatingBoundary: (() => {
        const host = document.querySelector('#fluent-read-floating-ball-container');
        return { present: Boolean(host), pageVisibleShadowRoot: Boolean(host?.shadowRoot) };
      })(),
      selectionBoundary: (() => {
        const host = document.querySelector('#fluent-read-selection-translator-container');
        return { present: Boolean(host), pageVisibleShadowRoot: Boolean(host?.shadowRoot) };
      })(),
      imageBoundary: (() => {
        const host = document.querySelector('#fluent-read-image-translation-root');
        return { present: Boolean(host), pageVisibleShadowRoot: Boolean(host?.shadowRoot) };
      })(),
    };
  }, { marker });
}

async function dispatchUntrustedControls(page, marker) {
  return page.evaluate(({ marker: secretMarker }) => {
    const observations = [];
    const record = (event) => observations.push({ type: event.type, isTrusted: event.isTrusted });
    for (const type of ['fluent:prefill', 'fluentread-toggle-translation', 'keydown', 'keyup']) {
      document.addEventListener(type, record, { capture: true });
    }

    const prefillTarget = document.querySelector('#fluent-new-api-container') || document;
    prefillTarget.dispatchEvent(new CustomEvent('fluent:prefill', {
      bubbles: true,
      composed: true,
      detail: {
        id: 'new-api',
        baseUrl: 'https://attacker.invalid/v1',
        apiKey: secretMarker,
        model: 'attacker-model',
      },
    }));
    document.dispatchEvent(new CustomEvent('fluentread-toggle-translation', {
      bubbles: true,
      composed: true,
    }));

    const keyEvents = [
      new KeyboardEvent('keydown', { key: 'Alt', code: 'AltLeft', altKey: true, bubbles: true, cancelable: true }),
      new KeyboardEvent('keydown', { key: 't', code: 'KeyT', altKey: true, bubbles: true, cancelable: true }),
      new KeyboardEvent('keyup', { key: 't', code: 'KeyT', altKey: true, bubbles: true, cancelable: true }),
      new KeyboardEvent('keyup', { key: 'Alt', code: 'AltLeft', bubbles: true, cancelable: true }),
    ];
    keyEvents.forEach((event) => document.dispatchEvent(event));
    return observations;
  }, { marker });
}

function assertLegacyCacheBoundary(initialStorage, migratedStorage) {
  if (initialStorage[HOST_SENTINEL_KEY] !== HOST_SENTINEL_VALUE) throw new Error('fixture 未正确预置 host sentinel');
  if (migratedStorage[HOST_SENTINEL_KEY] !== HOST_SENTINEL_VALUE || migratedStorage[HOST_PREFERENCE_KEY] !== HOST_PREFERENCE_VALUE) {
    throw new Error(`内容脚本删除了宿主 localStorage：${JSON.stringify(migratedStorage)}`);
  }
  for (const key of [...LEGACY_CACHE_KEYS, LEGACY_TIMESTAMP_KEY]) {
    if (Object.prototype.hasOwnProperty.call(migratedStorage, key)) {
      throw new Error(`旧版 FluentRead 页面缓存未删除：${key}`);
    }
  }
  const remainingKeys = Object.keys(migratedStorage).sort();
  const expectedKeys = [HOST_PREFERENCE_KEY, HOST_SENTINEL_KEY].sort();
  if (JSON.stringify(remainingKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`页面 localStorage 出现非宿主键：${JSON.stringify(remainingKeys)}`);
  }
}

function assertPrivacyBoundary(state, storageEvidence, dialogs, extensionPages, networkEvents) {
  if (state.bilingualCount || state.loadingCount || state.retryCount) {
    throw new Error(`网页伪造控制触发了翻译状态：${JSON.stringify(state)}`);
  }
  if (state.newApiContainerPresent || dialogs.length > 0) {
    throw new Error(`网页伪造 prefill 暴露了配置入口：${JSON.stringify({ dialogs, newApiContainerPresent: state.newApiContainerPresent })}`);
  }
  if (extensionPages.length > 0) throw new Error(`网页事件打开了扩展页面：${JSON.stringify(extensionPages)}`);
  if (networkEvents.length > 0) throw new Error(`网页伪造控制发起了翻译网络请求：${JSON.stringify(networkEvents)}`);
  if (storageEvidence.localContainsPrefillMarker || storageEvidence.sessionContainsPrefillMarker) {
    throw new Error('网页提供的伪造凭据进入了扩展存储');
  }
  if (storageEvidence.decryptedRecordsContainPrefillMarker || storageEvidence.rawIndexedDbContainsPrefillMarker) {
    throw new Error('网页提供的伪造凭据进入了加密配置数据库');
  }
  if (!storageEvidence.indexedDb.recordsUseEncryptedEnvelope
    || storageEvidence.indexedDb.legacyLocalKeys.length
    || storageEvidence.indexedDb.legacySessionKeys.length) {
    throw new Error(`配置存储边界异常：${JSON.stringify(storageEvidence.indexedDb)}`);
  }
  if (storageEvidence.configContainsCredentialFields || storageEvidence.historyContainsCredentialFields) {
    throw new Error('公开 local config/configHistory 仍包含凭据字段');
  }
  if (state.domContainsPrefillMarker || state.pageCanAccessChromeStorage || state.pageCanAccessBrowserStorage) {
    throw new Error(`宿主页面能够观察凭据或扩展存储：${JSON.stringify(state)}`);
  }
  if (!state.areaBoundary.present || state.areaBoundary.pageVisibleShadowRoot) {
    throw new Error(`圈选翻译没有保持 closed Shadow DOM：${JSON.stringify(state.areaBoundary)}`);
  }
  if (!state.floatingBoundary.present || state.floatingBoundary.pageVisibleShadowRoot) {
    throw new Error(`悬浮球没有保持 closed Shadow DOM：${JSON.stringify(state.floatingBoundary)}`);
  }
  if (!state.selectionBoundary.present || state.selectionBoundary.pageVisibleShadowRoot) {
    throw new Error(`划词翻译没有保持 closed Shadow DOM：${JSON.stringify(state.selectionBoundary)}`);
  }
  if (!state.imageBoundary.present || state.imageBoundary.pageVisibleShadowRoot) {
    throw new Error(`图片翻译没有保持 closed Shadow DOM：${JSON.stringify(state.imageBoundary)}`);
  }
}

async function writeEvidence(artifactsDir, evidence) {
  fs.mkdirSync(artifactsDir, { recursive: true });
  const evidencePath = path.join(artifactsDir, 'privacy-boundary-evidence.json');
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return evidencePath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const extensionDir = path.resolve(args.extensionDir);
  const playwrightRoot = path.resolve(args.playwrightRoot);
  const artifactsDir = path.resolve(args.artifactsDir);
  const browserPath = resolveBrowserExecutable(args.browserPath);
  const manifestEvidence = readManifest(extensionDir);
  const credentialSentinel = `${CREDENTIAL_SENTINEL_PREFIX}${randomUUID()}`;
  const credentialSentinelSha256 = createHash('sha256').update(credentialSentinel).digest('hex');
  const privacySurfaceClientId = `privacy-boundary-surface-setup-${randomUUID()}`;
  const credentialMessageClientId = `privacy-boundary-credential-lifecycle-${randomUUID()}`;
  fs.mkdirSync(artifactsDir, { recursive: true });

  const { chromium } = loadPlaywright(playwrightRoot);
  let fixture;
  let primaryError;
  let evidencePath;
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluentread-privacy-boundary-'));
  const browserArgs = [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  let browserSession;
  let context;
  let createPage;
  let activatePage;
  let page;
  let optionsPage;
  let evidence = {
    ok: false,
    extensionDir,
    browserPath,
    fixtureUrl: null,
    windowMode: args.background ? 'background-screen-off' : 'headed-isolated',
    launchMode: null,
    focusPolicy: null,
    windowPlacement: null,
    isolation: { temporaryProfile: true, profileDir, reusedUserProfile: false },
    manifest: manifestEvidence,
    credentialSentinelSha256,
    screenshots: [],
  };

  const dialogs = [];
  const consoleErrors = [];
  const networkEvents = [];
  const translationUrlPattern = /translate|translatetext|cognitive\.microsofttranslator|generativelanguage|api\.openai|deeplx|fanyi|bigmodel|dashscope/i;
  const redactEvidenceText = (value) => String(value)
    .replaceAll(PREFILL_SECRET_MARKER, '[redacted-prefill-marker]')
    .replaceAll(credentialSentinel, '[redacted-credential-sentinel]');
  const recordRequest = (request) => {
    if (translationUrlPattern.test(request.url())) {
      networkEvents.push({ method: request.method(), url: safeUrl(request.url()) });
    }
  };

  let launchAttempted = false;
  try {
    assertDedicatedTemporaryProfile(profileDir);
    fixture = await startFixtureServer();
    evidence.fixtureUrl = fixture.url;
    if (args.background) {
      const {
        activateExtensionTabWithoutForeground,
        launchFocusSafePersistentContext,
        newPageWithoutForeground,
      } = loadFocusSafeBrowser(args.focusSafeHelper);
      launchAttempted = true;
      browserSession = await launchFocusSafePersistentContext({
        chromium,
        profileDir,
        browserPath,
        headless: false,
        background: true,
        browserArgs,
        viewport: { width: 1280, height: 900 },
        timeout: args.timeout,
      });
      guardBrowserClose(browserSession, profileDir);
      context = browserSession.context;
      createPage = () => newPageWithoutForeground(context, args.timeout);
      activatePage = (targetPage) => activateExtensionTabWithoutForeground(context, targetPage, args.timeout);
      evidence = {
        ...evidence,
        launchMode: browserSession.launchMode,
        focusPolicy: browserSession.focusPolicy,
        windowPlacement: browserSession.windowPlacement,
      };
    } else {
      launchAttempted = true;
      context = await chromium.launchPersistentContext(profileDir, {
        executablePath: browserPath,
        headless: false,
        viewport: { width: 1280, height: 900 },
        args: browserArgs,
      });
      createPage = () => context.newPage();
      activatePage = async () => undefined;
      evidence = {
        ...evidence,
        launchMode: 'playwright-headed',
        focusPolicy: 'foreground-authorized',
        windowPlacement: { state: 'normal', width: 1280, height: 900 },
      };
    }
    context.on('request', recordRequest);

    const worker = await waitForExtensionWorker(context, args.timeout);
    const extensionId = new URL(worker.url()).hostname;
    optionsPage = await openOptionsPage(
      createPage,
      activatePage,
      extensionId,
      manifestEvidence.optionsPage,
      args.timeout,
    );
    optionsPage.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(redactEvidenceText(message.text()).slice(0, 500));
      }
    });
    page = await createPage();
    page.on('dialog', async (dialog) => {
      dialogs.push({ type: dialog.type(), message: redactEvidenceText(dialog.message()) });
      await dialog.dismiss().catch(() => {});
    });
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(redactEvidenceText(message.text()).slice(0, 500));
      }
    });

    await page.goto(fixture.url, { waitUntil: 'domcontentloaded', timeout: args.timeout });
    await activatePage(page);
    await page.waitForSelector('#fluent-read-page-styles', { state: 'attached', timeout: args.timeout });
    await page.waitForFunction(
      ({ legacyKeys, timestampKey }) => legacyKeys.every((key) => localStorage.getItem(key) === null) && localStorage.getItem(timestampKey) === null,
      { legacyKeys: LEGACY_CACHE_KEYS, timestampKey: LEGACY_TIMESTAMP_KEY },
      { timeout: args.timeout },
    );
    const initialStorage = await page.evaluate(() => window.__privacyBoundaryInitialStorage);
    const migratedStorage = await page.evaluate(storageObjectFromPage);
    assertLegacyCacheBoundary(initialStorage, migratedStorage);

    const configuredSurfaces = await configurePrivacySurfaces(
      optionsPage,
      privacySurfaceClientId,
      args.timeout,
    );
    await page.reload({ waitUntil: 'domcontentloaded', timeout: args.timeout });
    await page.waitForSelector('#fluent-read-page-styles', { state: 'attached', timeout: args.timeout });
    await page.waitForSelector('#fluent-read-floating-ball-container', { state: 'attached', timeout: args.timeout });
    await page.waitForSelector('#fluent-read-selection-translator-container', { state: 'attached', timeout: args.timeout });
    if (await page.locator('#fluent-read-area-translator-container').count()) {
      throw new Error('未触发圈选翻译时已注入圈选宿主');
    }
    await activatePage(page);
    await page.locator('h1').click();
    await page.keyboard.press('Shift+Z');
    await page.waitForSelector('#fluent-read-area-translator-container', { state: 'attached', timeout: args.timeout });
    await page.keyboard.press('Escape');
    await page.hover('#privacy-image');
    await page.waitForSelector('#fluent-read-image-translation-root', { state: 'attached', timeout: args.timeout });
    await page.screenshot({ path: path.join(artifactsDir, 'privacy-boundary-before-events.png'), fullPage: true });
    evidence.screenshots.push(path.join(artifactsDir, 'privacy-boundary-before-events.png'));

    const storageBefore = await extensionStorageEvidence(optionsPage, PREFILL_SECRET_MARKER);
    const extensionPagesBefore = context.pages()
      .map((candidate) => candidate.url())
      .filter((url) => url.startsWith(`chrome-extension://${extensionId}/`));
    const networkStart = networkEvents.length;
    const untrustedEventObservations = await dispatchUntrustedControls(page, PREFILL_SECRET_MARKER);
    await page.waitForTimeout(1_500);
    const storageAfter = await extensionStorageEvidence(optionsPage, PREFILL_SECRET_MARKER);
    const finalState = await pageBoundaryState(page, PREFILL_SECRET_MARKER);
    const extensionPagesAfter = context.pages()
      .map((candidate) => candidate.url())
      .filter((url) => url.startsWith(`chrome-extension://${extensionId}/`) && !extensionPagesBefore.includes(url));
    const eventNetworkEvents = networkEvents.slice(networkStart);

    assertLegacyCacheBoundary(initialStorage, finalState.storage);
    assertPrivacyBoundary(finalState, storageAfter, dialogs, extensionPagesAfter, eventNetworkEvents);
    if (!untrustedEventObservations.every((event) => event.isTrusted === false)) {
      throw new Error(`fixture 事件并非全部为不可信事件：${JSON.stringify(untrustedEventObservations)}`);
    }

    const finalScreenshot = path.join(artifactsDir, 'privacy-boundary-final.png');
    await page.screenshot({ path: finalScreenshot, fullPage: true });
    evidence.screenshots.push(finalScreenshot);

    const persistentExpected = {
      sessionCredentialsPresent: false,
      sessionCredentialsContainsSentinel: false,
      localCredentialsPresent: true,
      localCredentialsContainsSentinel: true,
    };

    const credentialMessage = await persistCredentialViaExtensionMessage(
      optionsPage,
      credentialSentinel,
      credentialMessageClientId,
    );
    const persistentAfterMessage = await waitForCredentialStorageState(
      optionsPage,
      credentialSentinel,
      persistentExpected,
      args.timeout,
    );
    assertCredentialStorageState('可信扩展页消息保存后', persistentAfterMessage, persistentExpected);
    // pagehide 会提交 options 当前 Vue 快照；先确认运行时已接收后台的持久凭据，
    // 再重载页面，避免旧页面快照覆盖刚写入的 API Key。
    const optionsRuntimeHydratedBeforeReload = await waitForOptionsRuntimeCredential(
      optionsPage,
      credentialSentinel,
      args.timeout,
    );

    await optionsPage.reload({ waitUntil: 'domcontentloaded', timeout: args.timeout });
    await waitForOptionsUi(optionsPage, args.timeout);
    const optionsRuntimeHydratedAfterReload = await waitForOptionsRuntimeCredential(
      optionsPage,
      credentialSentinel,
      args.timeout,
    );
    const persistentAfterOptionsReload = await waitForCredentialStorageState(
      optionsPage,
      credentialSentinel,
      persistentExpected,
      args.timeout,
    );
    assertCredentialStorageState('设置页重载后', persistentAfterOptionsReload, persistentExpected);

    const exportEvidence = await exportCompleteBackupViaOptionsUi(
      optionsPage,
      credentialSentinel,
      args.timeout,
      artifactsDir,
    );
    if (!exportEvidence.containsCredentialSentinel || !exportEvidence.containsCredentialFields) {
      throw new Error(`设置页完整备份缺少凭据：${JSON.stringify(exportEvidence)}`);
    }
    if (!exportEvidence.legacyPolicyFieldAbsent) {
      throw new Error(`设置页完整备份仍包含已废弃的 persistCredentials 字段：${JSON.stringify(exportEvidence)}`);
    }
    if (exportEvidence.format !== 'fluentread-data-backup'
      || exportEvidence.version !== 2
      || exportEvidence.configCredentialMode !== 'exact-replace') {
      throw new Error(`设置页未导出当前完整备份格式：${JSON.stringify(exportEvidence)}`);
    }
    if (exportEvidence.includesPrivateVocabularyContext !== false) {
      throw new Error(`设置页默认导出泄露了单词上下文：${JSON.stringify(exportEvidence)}`);
    }
    if (exportEvidence.service !== 'openai') {
      throw new Error(`设置页完整备份没有反映可信消息保存的公开配置：${JSON.stringify(exportEvidence)}`);
    }
    const persistentScreenshot = path.join(artifactsDir, 'credentials-persistent.png');
    await optionsPage.screenshot({ path: persistentScreenshot, fullPage: true });
    evidence.screenshots.push(persistentScreenshot);

    // 页面 reload 只能证明 Vue 重新挂载；这里真实重载扩展运行时，随后重新打开同一
    // 临时 profile 的设置页，证明 API Key 的恢复不依赖旧 background 内存。
    await optionsPage.evaluate(() => {
      setTimeout(() => chrome.runtime.reload(), 50);
      return true;
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (!optionsPage.isClosed()) await optionsPage.close().catch(() => {});

    let reopenError;
    optionsPage = null;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      try {
        optionsPage = await openOptionsPage(
          createPage,
          activatePage,
          extensionId,
          manifestEvidence.optionsPage,
          args.timeout,
        );
        break;
      } catch (error) {
        reopenError = error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    if (!optionsPage) {
      throw new Error(`扩展运行时重载后无法重新打开设置页：${reopenError instanceof Error ? reopenError.message : String(reopenError)}`);
    }
    optionsPage.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(redactEvidenceText(message.text()).slice(0, 500));
      }
    });
    const optionsRuntimeHydratedAfterExtensionReload = await waitForOptionsRuntimeCredential(
      optionsPage,
      credentialSentinel,
      args.timeout,
    );
    const persistentAfterExtensionReload = await waitForCredentialStorageState(
      optionsPage,
      credentialSentinel,
      persistentExpected,
      args.timeout,
    );
    assertCredentialStorageState('扩展运行时重载后', persistentAfterExtensionReload, persistentExpected);
    const extensionReloadScreenshot = path.join(artifactsDir, 'credentials-persistent-after-extension-reload.png');
    await optionsPage.screenshot({ path: extensionReloadScreenshot, fullPage: true });
    evidence.screenshots.push(extensionReloadScreenshot);

    // 等待防抖历史快照落盘，再重复检查导出/历史不会在稍后泄露凭据。
    await optionsPage.waitForTimeout(600);
    const credentialFinal = await extensionStorageEvidence(
      optionsPage,
      PREFILL_SECRET_MARKER,
      credentialSentinel,
    );
    assertCredentialStorageState('凭据生命周期最终状态', credentialFinal, persistentExpected);
    const credentialFinalScreenshot = path.join(artifactsDir, 'credentials-persistent-restored.png');
    await optionsPage.screenshot({ path: credentialFinalScreenshot, fullPage: true });
    evidence.screenshots.push(credentialFinalScreenshot);
    if (consoleErrors.length > 0) {
      throw new Error(`隔离隐私回归出现控制台错误：${JSON.stringify(consoleErrors)}`);
    }

    evidence = {
      ...evidence,
      ok: true,
      extensionId,
      configuredSurfaces,
      legacyPageCache: {
        initialKeys: Object.keys(initialStorage).sort(),
        finalKeys: Object.keys(finalState.storage).sort(),
        hostSentinelPreserved: finalState.storage[HOST_SENTINEL_KEY] === HOST_SENTINEL_VALUE,
        removedKeys: [...LEGACY_CACHE_KEYS, LEGACY_TIMESTAMP_KEY],
      },
      storageBefore,
      storageAfter,
      untrustedControls: {
        observations: untrustedEventObservations,
        dialogs,
        extensionPagesOpened: extensionPagesAfter,
        translationNetworkRequests: eventNetworkEvents,
        translatedNodes: finalState.bilingualCount,
        loadingNodes: finalState.loadingCount,
        retryNodes: finalState.retryCount,
      },
      hostBoundary: {
        pageCanAccessChromeStorage: finalState.pageCanAccessChromeStorage,
        pageCanAccessBrowserStorage: finalState.pageCanAccessBrowserStorage,
        domContainsPrefillMarker: finalState.domContainsPrefillMarker,
        newApiContainerPresent: finalState.newApiContainerPresent,
      },
      shadowBoundary: {
        area: finalState.areaBoundary,
        floating: finalState.floatingBoundary,
        selection: finalState.selectionBoundary,
        image: finalState.imageBoundary,
        extensionHosts: finalState.extensionHosts,
      },
      credentialLifecycle: {
        saveTransport: 'chrome.runtime.sendMessage from options extension origin',
        saveAcknowledged: credentialMessage.acknowledged,
        directStorageWriteUsedForCredentialSave: false,
        optionsRuntimeHydratedBeforeReload,
        optionsRuntimeHydratedAfterReload,
        optionsRuntimeHydratedAfterExtensionReload,
        persistentAfterMessage,
        persistentAfterOptionsReload,
        persistentAfterExtensionReload,
        export: exportEvidence,
        final: credentialFinal,
        legacyToggleAbsent: true,
      },
      consoleErrors,
    };
  } catch (error) {
    primaryError = error;
    process.exitCode = 1;
    evidence = {
      ...evidence,
      error: redactEvidenceText(error instanceof Error ? error.message : String(error)),
      dialogs,
      consoleErrors,
      translationNetworkRequests: networkEvents,
    };
    if (optionsPage && !optionsPage.isClosed()) {
      const credentialFailureScreenshot = path.join(artifactsDir, 'credentials-lifecycle-failure.png');
      await optionsPage.screenshot({ path: credentialFailureScreenshot, fullPage: true }).then(() => {
        evidence.screenshots.push(credentialFailureScreenshot);
      }).catch(() => {});
    }
    if (page && !page.isClosed()) {
      const failureScreenshot = path.join(artifactsDir, 'privacy-boundary-failure.png');
      await page.screenshot({ path: failureScreenshot, fullPage: true }).then(() => {
        evidence.screenshots.push(failureScreenshot);
      }).catch(() => {});
    }
  } finally {
    const cleanupErrors = [];
    const cleanup = async action => {
      try {await action();} catch (error) {cleanupErrors.push(error);}
    };
    let browserClosed = false;
    await cleanup(async () => {
      if ((browserSession || context)) {await (browserSession || context).close(); browserClosed = true;}
    });
    await cleanup(async () => {await closeServer(fixture?.server);});
    await cleanup(() => {
      if (browserClosed) fs.rmSync(profileDir, {recursive: true, force: true});
      else if (!launchAttempted) {
        // No browser launch was attempted; only remove an empty initial profile.
        try {fs.rmdirSync(profileDir);} catch (error) {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
        }
      }
      evidence.isolation.temporaryProfileRemoved = !fs.existsSync(profileDir);
    });
    if (cleanupErrors.length) {
      evidence.ok = false;
      evidence.cleanupErrors = cleanupErrors.map(error => redactEvidenceText(error.stack || String(error)));
    }
    await cleanup(async () => {evidencePath = await writeEvidence(artifactsDir, evidence);});
    for (const error of cleanupErrors) process.stderr.write(`Cleanup failed: ${redactEvidenceText(error.stack || error)}\n`);
    if (cleanupErrors.length && !primaryError) throw cleanupErrors[0];
  }

  const output = { ...evidence, evidencePath };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!evidence.ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
