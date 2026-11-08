import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {dirname, resolve} from 'node:path';
import type {Plugin} from 'vite';

// 仅修改发货构建中的固定 SDK；原 node_modules 和 worker/core 资源均保持原样。
const SDK_SHA256 = '730c82036c801416256cdbf4bf36df934b0f25f2dcb3913454bccd9e2cfdb857';

export function tesseractSdkBuildPlugin(): Plugin {
    return {
        name: 'fluent-read-tesseract-sdk-initialization',
        enforce: 'pre',
        apply: 'build',
        transform(source, id) {
            if (id.includes('\0')) return;
            const file = id.split('?')[0].replace(/\\/g, '/');
            if (!/(?:^|\/)tesseract\.js\/src\/createWorker\.js$/.test(file)) return;
            const version = JSON.parse(fs.readFileSync(resolve(dirname(file), '../package.json'), 'utf8')).version;
            if (version !== '7.0.0' || createHash('sha256').update(source).digest('hex') !== SDK_SHA256) {
                throw new Error('Unsupported tesseract.js 7.0.0 createWorker source: review SDK initialization packaging');
            }
            const patches = [
                ['  workerCounter += 1;\n\n  const startJob', `  workerCounter += 1;

  let initializing = true;
  const failInitialization = (error) => {
    if (!initializing) return;
    initializing = false;
    workerResReject(error);
    for (const promiseId of Object.keys(promises)) {
      promises[promiseId].reject(error);
      delete promises[promiseId];
    }
    if (worker !== null) {
      const ownedWorker = worker;
      worker = null;
      // 清理失败不能替换导致初始化失败的原始错误。
      try { terminateWorker(ownedWorker); } catch {}
    }
  };
  worker.onerror = (event) => {
    if (initializing) failInitialization(event.message);
    else workerError(event);
  };

  const startJob`],
                ['  }) => {\n    const promiseId = `${action}-${jobId}`;', '  }) => {\n    if (worker === null) return;\n    const promiseId = `${action}-${jobId}`;'],
                ["      if (action === 'load') workerResReject(data);\n      if (errorHandler) {\n        errorHandler(data);\n      } else {\n        throw Error(data);\n      }", `      const startupFailure = initializing;
      if (startupFailure) failInitialization(data);
      else if (action === 'load') workerResReject(data);
      if (errorHandler) {
        errorHandler(data);
      } else if (!startupFailure) {
        throw Error(data);
      }`],
                ['    .then(() => workerResResolve(resolveObj))\n    .catch(() => {});', `    .then(() => { initializing = false; workerResResolve(resolveObj); })
    .catch(failInitialization);`],
            ];
            for (const [before, after] of patches) {
                if (source.split(before).length !== 2) throw new Error('Missing or ambiguous pinned Tesseract SDK patch match');
                source = source.replace(before, after);
            }
            return {code: source, map: null};
        },
    };
}
