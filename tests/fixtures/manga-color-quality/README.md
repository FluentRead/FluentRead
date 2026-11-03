<!--
@file tests/fixtures/manga-color-quality/README.md
文件职责：说明八类原创彩色漫画的源冻结、便携重建、持续回归与真实失败边界。
主要内容：固定完整原文和 RGBA 真值，区分源文件 CI、真实 OCR、原生解码与译图像素验收。
模块边界：不分发字体或模型，不以离线真值回放、RGB 探针或候选识别改善冒充完整生产通过。
-->
# 彩色漫画与图片回归源

这八幅原创确定性图像有34条完整原文、23个独立段落、15个无字负区、21个不透明 RGB 保护点、8个 RGBA 保护点，以及3块共4800像素的透明镂空保护区。7幅有字图可用于漫画和普通图片入口；完整无字图只用于漫画入口。每一幅都在首次 OCR 前冻结，不按识别结果删图、改字、移动框或调整保护区域。

| 场景 | 独立结构与压力 |
| --- | --- |
| harbor-same-red-channel-dialogue | 港口插画中两个不同底色气泡，原文与底色 R 相同但 G/B 不同；另有独立旁白。 |
| prism-platform-gradient-signs | 渐变站台牌、反色信息牌、独立数字标签与不同方向的结构线。 |
| rain-garden-vertical-ruby-sidebar | 日文竖列、细注音与中文横向说明，花园插画和边栏保持独立。 |
| chess-picnic-neighbor-inverse-bubbles | 相邻白底黑字和黑底白字气泡；下方棋盘与器皿是负区。 |
| lantern-market-oblique-bilingual-captions | 倾斜双语说明、小字标签与灯笼市集，描边和旋转均计入实际字形边界。 |
| watercolor-ferry-translucent-notification | 水彩式渡轮画面、半透明提示与独立侧注，保留真实 source-over alpha。 |
| orbital-greenhouse-cutout-dialogue | 轨道温室、透明图层与两个邻近对白，两个完整透明孔不能被填平。 |
| wordless-stained-glass-cutout-garden | 无文字彩色玻璃花园与透明镂空；不能把纹理或符号当作对白。 |

五组非端点同 R 关系使用128、137或112等值；并非只覆盖纯白/纯黑边缘。完整字形最小字号20px，不声称覆盖6px尾字或10px数字。图形、文字、排布均为测试原创，无外部漫画图像或实现代码。

`manifest.json`、`design.json` 和58个像素载荷保留原冻结的全部字节：8张源 PNG、8张无字背景、34张独立字形 PNG、8份压缩的源 RGBA，共1663952字节（含两份元数据）。所有文字、标点、出现次数、物理字形框、独立段落及负区保持原样。历史 manifest 中的 `generator`、`generatorSha256` 和“未运行 OCR”说明也保留；后来的观测另存于 `first-ocr-baseline.json`。维护脚本的路径和 SHA 单独记录于 `provenance.json`，避免为了迁移目录改写首次冻结。

从仓库根目录运行不需要字体、Pillow、模型或浏览器的检查：

```sh
node scripts/testing/check-manga-color-quality-fixtures.cjs
pnpm exec vitest run tests/mangaColorQualityCorpus.test.ts
```

Node checker 在读取载荷前检查固定文件大小和物理目录边界，固定完整 manifest/design SHA 后再检查58份载荷 SHA、PNG 头、源 RGBA、保护点和全部透明孔像素。一次只解压一幅源图，最大6600000字节；不把整套44880000字节的原始像素同时保留。它复用公共 `manga-quality-corpus.cjs`，要求8份完美真值回放通过，并严格拒绝105个错字、重复文字、艺术区误报、多余字、误合段、误拆段和无字页标点反例。functional 测试还用实际临时文件证明自洽篡改真值、分组、边界、像素以及删图/重复图不能通过。它们验证源与验收门禁，**不是生产 OCR 或修补通过记录**。

需要重新绘图时只生成到一个不存在的新目录：

```sh
python3 scripts/testing/generate-manga-color-quality-fixtures.py \
  --out-dir /private/tmp/new-manga-color-quality
```

要求 Pillow12.3.0 和 `design.json` 中的四份同 SHA 字体。默认读取本机 macOS 字体；其他机器可用 `--bold-font`、`--regular-font`、`--cjk-font`、`--zh-font` 显式指定相同字节的本地文件，不允许字体替代。字形 cmap 必须覆盖全部声明文字。所有图像、字形和完整 manifest 先与原冻结逐项比较，全部通过后才独占创建目录并以 `xb` 写文件；已有文件、目录、空目录或悬空符号链接均拒绝。Pillow、FreeType、zlib 或字体版本造成的字节漂移应失败，不更新真值来迁就本地环境。CI 只校验已冻结资产，不依赖系统字体或 Pillow。字体文件、模型权重、原始 tensor 和过程日志均不入库。

真实生产回归仍需要构建好的 Chrome MV3 产物、Playwright，以及仓库既有的 focus-safe helper。下面两组命令复用**同一固定模型目录**，模型按既有完整性校验命中缓存；首次缺少模型时可能下载，不能仅凭目录参数宣称0下载。请检查实际报告中的缓存、模型请求、诊断与清理字段。`PLAYWRIGHT_ROOT`、`FLUENTREAD_FOCUS_SAFE_HELPER` 和 `MODEL_CACHE_DIR` 应先设置为机器上的实际绝对路径，使用临时 profile，不连接日常浏览器。

```sh
MODEL_CACHE_DIR="/absolute/path/to/shared-model-cache"
node scripts/testing/run-manga-translation-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root "$PLAYWRIGHT_ROOT" \
  --focus-safe-helper "$FLUENTREAD_FOCUS_SAFE_HELPER" \
  --quality-manifest tests/fixtures/manga-color-quality/manifest.json \
  --quality-profile manga --model-cache-dir "$MODEL_CACHE_DIR" \
  --artifacts-dir /private/tmp/new-color-quality-manga
```

普通图片只删除无字页，保留其余7个 fixture 对象的全部字段。临时 manifest 放在相同目录，使原相对源文件路径不变；独占写入，已有同名文件时失败，不覆盖原 manifest。

```sh
node --input-type=commonjs <<'NODE'
const fs = require('node:fs');
const root = 'tests/fixtures/manga-color-quality/';
const original = JSON.parse(fs.readFileSync(root + 'manifest.json', 'utf8'));
const ordinary = {...original, fixtures: original.fixtures.filter(f => !f.expectedNoText)};
if (ordinary.fixtures.length !== 7) throw new Error('Expected seven original text fixtures');
fs.writeFileSync(root + '.ordinary-seven.local.json', JSON.stringify(ordinary, null, 2) + '\n', {flag: 'wx'});
NODE
```

确认上一步成功创建新文件后，再运行普通图片回归并删除该临时 manifest。保留同一非空的固定缓存设置：

```sh
: "${MODEL_CACHE_DIR:?Set the same shared model cache directory first}"
node scripts/testing/run-manga-translation-test.cjs \
  --extension-dir .output/chrome-mv3 \
  --playwright-root "$PLAYWRIGHT_ROOT" \
  --focus-safe-helper "$FLUENTREAD_FOCUS_SAFE_HELPER" \
  --quality-manifest tests/fixtures/manga-color-quality/.ordinary-seven.local.json \
  --quality-profile image --model-cache-dir "$MODEL_CACHE_DIR" \
  --artifacts-dir /private/tmp/new-color-quality-image
rm tests/fixtures/manga-color-quality/.ordinary-seven.local.json
```

原生产 runner 检查 RGB 探针、真实 OCR、独立段落、原图恢复和缓存重显；它尚不执行这里新增的 RGBA 点/完整镂空矩形 oracle，保护断言失败还可能中止后续场景。RGB 探针通过不能证明所有 RGBA 像素、透明孔或字形范围保留。完整验收须另采原生 source/output RGBA，同时保留原 PNG 的 raw RGBA 真值；半透明像素经 Canvas premultiply/解码可能量化变化，必须分别报告 raw truth 与同一浏览器解码 source 的逐像素保持，不能把两者混成通过。额外 oracle 应累计译图失败而保持最后非零退出；原始源真值前置条件仍严格保留。

首轮实际 stock172c生产模型已观察8景，记录完整实际 `texts`、`ocrLines` 和失败：27/34锚点、15负区0误报，仅无字页严格通过（1/8）；所有7幅有字页仍有完整段落失败。独立像素 oracle 的 raw truth 为6/8，半透明提示与温室图共4个 RGBA 点不同；同一原生解码 source 的像素保持为8/8。这是解码/量化边界，不能声称 raw RGBA 全通过。三个透明孔的完整4800像素仍单独保留。此处不引入后续候选结果来重写首轮。

首轮是14景调用中的前8景；模型/运行时/清理记录属于该完整调用：4模型缓存命中、0下载、0模型请求，浏览器与 profile 已清理。质量失败导致整体诊断为失败；ORT placement 告警有1项独立事件、2条原始观察，未获 advisory 豁免，不称运行时全绿。该实际记录绑定报告、执行 runner 和构建库存 SHA；离线测试重算它的语义失败并固定完整文件 SHA，而非把失败样本改成期望通过。
