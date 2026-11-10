// Build-only worker: keep the compressor's process-level listeners out of Vite.
const {parentPort, workerData} = require('node:worker_threads');
const {gzipAsync} = require('@gfx/zopfli');

gzipAsync(workerData, {numiterations: 15, blocksplittingmax: 0}).then(result => parentPort.postMessage(result));
