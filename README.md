<div align="center">

<img src="./assets/brand/icon-512.png" alt="FluentRead" width="96" />

# FluentRead

**Closer languages. A bigger world.**

An open-source browser extension for bilingual translation.

[Install](#installation) · [Website](https://read.thinkstu.com/en/) · [User guide](https://read.thinkstu.com/en/guide/) · [Privacy policy](https://read.thinkstu.com/en/guide/privacy) · [简体中文](./misc/README_ZH.md) · [LINUX DO Community](https://linux.do) · [GPL-3.0](./LICENSE)

</div>

FluentRead displays translations alongside the original webpage and provides selection translation, AI reading assistance, image and document translation, and bilingual video subtitles. Its reading card integrates a **browser adaptation of the DeepSeek Harness session core** for contextual explanations and follow-up questions.

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

## DeepSeek Harness

The reading card adapts the conversation-event and message organization components of the DeepSeek Harness session core for the browser. FluentRead connects these to the selected text, permitted paragraph context, model services, and local reading history. It supports different AI providers and models, with optional learning memories.

The adaptation is used for selection-based reading assistance. Full-page, hover, and regular selection translation use their respective translation pipelines. See the [integration map](./docs/reports/harness-embedding-map-20260905.md) for scope and upstream references, and the [third-party notice](./public/third-party-notices/deepseek-harness-MIT.txt) for its MIT license.

[Reading card guide](https://read.thinkstu.com/en/guide/deepseek-harness)

## Installation

[Chrome](https://chromewebstore.google.com/detail/djnlaiohfaaifbibleebjggkghlmcpcj) · [Edge](https://microsoftedge.microsoft.com/addons/detail/kakgmllfpjldjhcnkghpplmlbnmcoflp) · [Firefox](https://addons.mozilla.org/en-US/firefox/addon/%E6%B5%81%E7%95%85%E9%98%85%E8%AF%BB/) · [Userscript](https://greasyfork.org/en/scripts/482986)

1. Install the extension and refresh the webpage.
2. Open FluentRead and select a target language. The source language defaults to automatic detection and can also be selected manually.
3. Choose “Translate page.” Enable selection translation and other tools in settings as needed.

Store updates may arrive at different times. The userscript provides core webpage translation features. See the [installation guide](https://read.thinkstu.com/en/guide/getting-started) for browser and feature availability.

## Local development

Requirements: Node.js 20 or later and pnpm 9.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Use `pnpm build` to build the Chrome extension, `pnpm compile` for type checking, and `pnpm docs:build` to build the website. See [architecture](./docs/architecture.md) and [testing](./docs/testing.md) for project conventions.

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

Settings and learning records stay local by default; cloud translation uses your selected provider. Optional cloud configuration backup supports Google Drive, [Dropbox](https://read.thinkstu.com/config/dropbox-sync), and [WebDAV](https://read.thinkstu.com/en/guide/webdav), including service credentials while excluding wordbooks, conversations, and usage statistics. See the [privacy policy](https://read.thinkstu.com/en/guide/privacy) for permissions, encryption, and deletion details.
