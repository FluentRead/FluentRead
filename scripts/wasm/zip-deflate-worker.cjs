// 仅供构建期：将 Zopfli 的进程级监听及内存隔离在可终止 worker 内。
const {parentPort, workerData} = require('node:worker_threads');
const {deflateAsync} = require('@gfx/zopfli');
deflateAsync(workerData, {numiterations: 1}).then(bytes => parentPort.postMessage(bytes));
