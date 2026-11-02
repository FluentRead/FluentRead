<div align="center">

<img src="./assets/brand/icon-512.png" alt="FluentRead" width="96" />

# FluentRead

**Closer languages. A bigger world.**

An open-source browser extension for bilingual translation.

[Install](#installation) · [Website](https://read.thinkstu.com/en/) · [User guide](https://read.thinkstu.com/en/guide/) · [Sponsorship](#sponsorship) · [Privacy policy](https://read.thinkstu.com/en/guide/privacy) · [简体中文](./misc/README_ZH.md) · [LINUX DO Community](https://linux.do) · [GPL-3.0](./LICENSE)

</div>

FluentRead displays translations alongside the original webpage and provides selection translation, AI reading assistance, image and document translation, and bilingual video subtitles. Its reading card provides contextual explanations and follow-up questions.

<div align="center">

[![FluentRead introduction video](./docs/public/videos/fluentread-promo-en-poster.webp)](https://read.thinkstu.com/videos/fluentread-promo-en.mp4)

[▶ Watch the 56-second introduction](https://read.thinkstu.com/videos/fluentread-promo-en.mp4)

For a closer look, [watch the full official introduction (4+ minutes, in Chinese on Bilibili)](https://www.bilibili.com/video/BV1qhHJ6uEiF/).

</div>

[![FluentRead bilingual webpage translation](./docs/public/screenshots/en/translation.webp)](./docs/public/screenshots/en/translation.webp)

## Features

| Feature | Description |
| --- | --- |
| Webpage translation | Bilingual page translation, hover and selection translation, original-text restoration, and automatic translation rules. |
| AI reading card | Meaning, sentence analysis, usage explanations, and practice, with paragraph context and follow-up questions. |
| Learning center | Save words, phrases, and sentences with their original context for study and review. |
| Image and area translation | Recognize text in webpage images or selected screen areas and display translations that can be copied. |
| Document translation | Read PDF, ePub, DOCX, and other supported formats in two languages, edit translations, and export files. |
| Video subtitles | Bilingual subtitles on YouTube and X; supported X videos can also use local AI transcription. |
| Services and settings | Free translation services, DeepL, AI providers, and local Ollama models, with glossaries, translation styles, shortcuts, and menu layout settings. |

See the [user guide](https://read.thinkstu.com/en/guide/) for instructions and supported formats. AI explanations require a configured AI service. Third-party pricing and availability depend on the provider.

## Installation

[Chrome](https://chromewebstore.google.com/detail/djnlaiohfaaifbibleebjggkghlmcpcj) · [Edge](https://microsoftedge.microsoft.com/addons/detail/kakgmllfpjldjhcnkghpplmlbnmcoflp) · [Firefox](https://addons.mozilla.org/en-US/firefox/addon/%E6%B5%81%E7%95%85%E9%98%85%E8%AF%BB/) · [Userscript](https://greasyfork.org/en/scripts/482986)

1. Install the extension and refresh the webpage.
2. Open FluentRead and select a target language. The source language defaults to automatic detection and can also be selected manually.
3. Choose “Translate page.” Enable selection translation and other tools in settings as needed.

Store updates may arrive at different times. The userscript provides core webpage translation features. See the [installation guide](https://read.thinkstu.com/en/guide/getting-started) for browser and feature availability.

## Sponsorship

The project is currently funded mainly out of pocket, with tens of thousands of US dollars spent each month on API tokens for open-source development. We believe FluentRead can make the world a little better.

<a href="mailto:a1914493943@gmail.com?subject=FluentRead%20sponsorship"><img src="./docs/public/support/sponsor-placeholder-en.svg" width="480" height="128" alt="Your brand here — become a FluentRead sponsor" /></a>

[Email us](mailto:a1914493943@gmail.com?subject=FluentRead%20sponsorship) · [Add on WeChat](https://read.thinkstu.com/support/wechat-contact.jpg)

## Local development

Requirements: Node.js 20 or later and pnpm 9.

Node.js 22.12 or later in the 22.x line is recommended, matching CI; `.nvmrc` selects Node 22. Check both `node --version` and `pnpm exec node --version` after switching. Older Node 20 releases can emit an experimental JSON-module warning from WXT's spinner dependency; using Node 22 avoids it without suppressing warnings. Type-check and userscript compression caches are described in [testing](./docs/testing.md#编译与构建缓存).

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Use `pnpm build` to build the Chrome extension and `pnpm zip` to generate one `-chrome.zip`, preserving its public key, fixed extension ID, and Google OAuth configuration. Use the same ZIP for manual installation and preparation for an update to the existing Chrome Web Store item. Packaging removes the obsolete `-chrome-store.zip` for the same version. See [extension identity and packages](./docs/maintainers/extension-identity-and-packages.md) for details.

Use `pnpm build:firefox` to build the Firefox extension, `pnpm zip:firefox` to generate its installation and review-source ZIPs, and `pnpm zip:edge` to generate the separate Microsoft Edge Add-ons ZIP without the Chrome `key`. The review-source ZIP includes the extension build inputs; website assets, test evidence, and other distribution targets are omitted. Use `pnpm compile` for type checking and `pnpm docs:build` to build the website. See [architecture](./docs/architecture.md) and [testing](./docs/testing.md) for project conventions.

For Mozilla reviewers, the Firefox build uses Node.js 20 or later, pnpm 9 (the exact pnpm version is pinned in `packageManager`), and the checked-in `pnpm-lock.yaml`. From the source ZIP root, run `pnpm install --frozen-lockfile` followed by `pnpm build:firefox`; the generated extension is in `.output/firefox-mv2`. No private credentials or `.env` file are needed. The build keeps the upstream vendor files intact and applies source-hash-checked adaptations in `scripts/testing/extension-csp-build.ts`, `scripts/testing/defuddle-entity-build.ts`, and `scripts/wasm/package-diagnostics.ts`. Those transformations are part of the submitted sources and run on every build.

The AMO warning remediation build was checked on macOS ARM64 with Node.js 20.11.1 and pnpm 9.12.1; there are no OS-specific native compilation steps for the extension. Vendored OCR sources and licenses are listed in `public/fluent-read-ocr/NOTICE.md`. The other patched packages and exact versions come from `package.json` and `pnpm-lock.yaml`: Tesseract.js/regenerator-runtime, JSZip, PDF.js, fontkit, lodash-es, ONNX Runtime Web, and Defuddle. Their original files remain available through the official npm packages. The CSP adaptations replace global-object fallbacks with `globalThis`, reject unused string timer callbacks, keep PDF.js on its interpreter, and replace the ONNX Emscripten invoker with a static closure. Defuddle's entity-decoding call is adapted to the shared `entities` text decoder; its original package is not modified. WASM binaries are unchanged.

Before AMO submission, install Mozilla's validator separately, for example `npm install --prefix /tmp/fluentread-amo-tools --ignore-scripts --no-audit --no-fund addons-linter@10.15.0`, then run `pnpm lint:firefox:amo --linter /tmp/fluentread-amo-tools/node_modules/.bin/addons-linter --report /tmp/fluentread-amo-report.json`. The command checks the built Firefox directory by default; pass the installation ZIP as the first argument to check that exact upload. It preserves the complete report and fails on errors or validator failure. Warnings remain visible for review. Successful local validation does not confirm AMO signing or approval.

Run `pnpm storybook` to explore the real Vue components and interface themes locally. See the [design system guide](./docs/en/guide/design-system.md). Use `pnpm docs:build:site` to build the documentation with the component explorer.

## Contributing

Report bugs and propose changes through [Issues](https://github.com/FluentRead/FluentRead/issues). Pull requests for code, documentation, interface translations, and [website adaptation](./docs/contributing/site-adaptation.md) are welcome.

## Support

FluentRead is an open-source project whose continued development is made possible by the generous support of its community. Voluntary contributions are welcome through either service.

<table>
<tr><th>WeChat Support</th><th>Ko-fi · International</th></tr>
<tr>
<td align="center"><a href="./misc/approve.jpg"><img src="./misc/approve.jpg" width="220" alt="Thinkstu’s WeChat support code" /></a><br />Scan with WeChat. Click the image to enlarge.</td>
<td align="center"><a href="https://ko-fi.com/thinkstu"><strong>Support thinkstu on Ko-fi ↗</strong></a><br /><br />ko-fi.com/thinkstu</td>
</tr>
</table>

## Acknowledgments

FluentRead grows alongside a vibrant open-source community. We are grateful to the following projects and their contributors for their openness and generosity:

- [Read Frog](https://github.com/mengxi-ream/read-frog)
- [KISS Translator](https://github.com/fishjar/kiss-translator)
- [Duo Translator](https://github.com/linuxscreen/duo-translator)
- [InfoLens](https://github.com/dqy08/InfoLens) — Smart Highlighting is inspired by its surprisal heatmap idea (Apache-2.0)

<!-- contributors:start -->
<a href="https://github.com/FluentRead/FluentRead/graphs/contributors">
  <table>
    <tr>
      <th>
        <br>
        <img src="https://avatars.githubusercontent.com/u/91378285?s=96&v=4" width="48" height="48" alt="Bistutu"><img src="https://avatars.githubusercontent.com/u/67351121?s=96&v=4" width="48" height="48" alt="WindChimeEcho"><img src="https://avatars.githubusercontent.com/u/15028142?s=96&v=4" width="48" height="48" alt="df123"><img src="https://avatars.githubusercontent.com/u/106456682?s=96&v=4" width="48" height="48" alt="RayySummers"><img src="https://avatars.githubusercontent.com/u/360470?s=96&v=4" width="48" height="48" alt="hewigovens"><img src="https://avatars.githubusercontent.com/u/10784701?s=96&v=4" width="48" height="48" alt="memwey"><img src="https://avatars.githubusercontent.com/u/6224049?s=96&v=4" width="48" height="48" alt="zhitiao"><img src="https://avatars.githubusercontent.com/u/27531296?s=96&v=4" width="48" height="48" alt="Meursau1T"><img src="https://avatars.githubusercontent.com/u/45133544?s=96&v=4" width="48" height="48" alt="520250"><img src="https://avatars.githubusercontent.com/u/104964583?s=96&v=4" width="48" height="48" alt="lemonteaau"><img src="https://avatars.githubusercontent.com/u/61247483?s=96&v=4" width="48" height="48" alt="Calcium-Ion"><img src="https://avatars.githubusercontent.com/u/555720?s=96&v=4" width="48" height="48" alt="pluwen"><img src="https://avatars.githubusercontent.com/u/30524126?s=96&v=4" width="48" height="48" alt="z0gSh1u"><img src="https://avatars.githubusercontent.com/u/78135443?s=96&v=4" width="48" height="48" alt="LIBai11"><img src="https://avatars.githubusercontent.com/u/3325888?s=96&v=4" width="48" height="48" alt="faintbear"><img src="https://avatars.githubusercontent.com/u/31530787?s=96&v=4" width="48" height="48" alt="damingsu"><img src="https://avatars.githubusercontent.com/u/86344183?s=96&v=4" width="48" height="48" alt="LinmonK"><img src="https://avatars.githubusercontent.com/u/113257654?s=96&v=4" width="48" height="48" alt="Alkacid"><img src="https://avatars.githubusercontent.com/u/10754850?s=96&v=4" width="48" height="48" alt="yolo2h"><img src="https://avatars.githubusercontent.com/u/253238660?s=96&v=4" width="48" height="48" alt="SyrupyTasty"><img src="https://avatars.githubusercontent.com/u/57394205?s=96&v=4" width="48" height="48" alt="NaCodermer"><img src="https://avatars.githubusercontent.com/u/57748455?s=96&v=4" width="48" height="48" alt="MrWangJustToDo"><img src="https://avatars.githubusercontent.com/u/19755727?s=96&v=4" width="48" height="48" alt="hu3rror"><img src="https://avatars.githubusercontent.com/u/73932916?s=96&v=4" width="48" height="48" alt="BalconyJH"><br>
        <br>
      </th>
    </tr>
  </table>
</a>
<!-- contributors:end -->

Thank you to everyone who has contributed to FluentRead, including the many we couldn't name here, and to every user for embracing a product that is still far from perfect. We hope to keep building together with you, and to bring a little more good into the world.

## License and privacy

FluentRead is released under [GPL-3.0](./LICENSE). See [third-party notices](./public/third-party-notices/) for component attribution and licenses.

Settings and learning records stay local by default; cloud translation uses your selected provider. Optional cloud configuration backup supports Google Drive and [WebDAV](https://read.thinkstu.com/en/guide/webdav), including service credentials while excluding wordbooks, conversations, and usage statistics. See the [privacy policy](https://read.thinkstu.com/en/guide/privacy) for permissions, encryption, and deletion details.
