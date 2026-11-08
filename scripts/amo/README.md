# Firefox source review

Use Node.js 20 or later and the pnpm 9 version pinned in `package.json`. Run these commands from the root of the extracted Firefox source ZIP.

```sh
pnpm install --frozen-lockfile
npm run build-for-amo
```

The extension is built in `.output/firefox-mv2`. The build needs no private credentials, `.env` file, or OS-specific native compilation. The AMO warning fixes were verified on macOS ARM64 with Node.js 20.11.1 and pnpm 9.12.1.

## Build inputs and adaptations

- The review ZIP contains the Firefox extension build inputs, including the lockfile. The source package excludes website assets, test evidence, and other distribution targets.
- `build-for-amo` runs `build:firefox` and normalizes the indentation of the generated `manifest.json`. Background builds pin the CryptoJS CommonJS initialization wrappers to keep the generated output consistent.
- The build checks the source hashes before applying its adaptations. [CSP adaptations](../testing/extension-csp-build.ts) replace global-object fallbacks with `globalThis`, reject string timer callbacks, keep PDF.js on its interpreter, and use a static closure for the ONNX Emscripten invoker. [Defuddle's adaptation](../testing/defuddle-entity-build.ts) uses the shared `entities` decoder. [WASM packaging](../wasm/package-diagnostics.ts) leaves the WASM binaries intact.
- The original Tesseract.js and regenerator-runtime, JSZip, PDF.js, fontkit, lodash-es, ONNX Runtime Web, and Defuddle sources are available from npm at the versions recorded in [the lockfile](../../pnpm-lock.yaml). See the [OCR notice](../../public/fluent-read-ocr/NOTICE.md) for vendored sources and licenses.
