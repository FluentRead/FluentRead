/**
 * @file scripts/testing/benchmark-privacy.mjs
 * 文件职责：用可复现的人工文本测量隐私识别、替换和恢复的本地开销。
 * 主要内容：打包实际纯核心后测量不同长度、128 条词典和不利前缀输入，输出机器信息及 p50/p95；不调用翻译服务。
 * 模块边界：只作为开发基准，不读用户文本，不声称与 NER 或其他产品有可直接比较的覆盖率。
 */
import {build} from 'esbuild';
import {cpus, platform, arch} from 'node:os';
import {performance} from 'node:perf_hooks';
const bundled = await build({entryPoints: ['src/core/privacy/session.ts'], bundle: true, platform: 'node', format: 'esm', write: false});
const {createPrivacySession} = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const policy = {enabled: true, mode: 'mask', categories: ['email', 'phone', 'identity', 'payment', 'secret', 'network']};
const terms = Array.from({length: 128}, (_, index) => `Confidential project example ${index}`);
const plain = 'This is ordinary prose about language learning, with no personal details. ';
const cases = [
  ['plain-2k', plain.repeat(30).slice(0, 2000), []],
  ['plain-20k', plain.repeat(300).slice(0, 20000), []],
  ['plain-100k', plain.repeat(1500).slice(0, 100000), []],
  ['sensitive-20k', ('Contact demo@example.test or phone +44 20 7946 0958. ').repeat(400), []],
  ['custom-128-20k', plain.repeat(280) + terms.join(' / '), terms],
  ['long-prefix-100k', ('a'.repeat(1000) + '@ ').repeat(100), terms],
];
const results = [];
for (const [name, text, custom] of cases) {
  const timings = []; let matches = 0;
  for (let iteration = 0; iteration < 110; iteration++) {
    const start = performance.now(); const session = createPrivacySession(policy, custom);
    const packet = session.mask(text); const restored = session.restore(packet.text, packet); matches = packet.spans.length;
    session.dispose(); if (restored !== text) throw new Error('Round-trip mismatch');
    if (iteration >= 10) timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  results.push({name, utf16Chars: text.length, customTerms: custom.length, matches, iterations: timings.length,
    p50Ms: +timings[49].toFixed(3), p95Ms: +timings[94].toFixed(3), maxMs: +timings.at(-1).toFixed(3)});
}
console.log(JSON.stringify({node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model,
  measurement: 'create detector + mask + strict restore + dispose; warm process; synthetic text; no network', results}, null, 2));
