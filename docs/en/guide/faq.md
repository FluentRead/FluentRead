---
outline: false
---

# Frequently asked questions

Make sure FluentRead is enabled. Refresh webpages after installation or an update, then follow the relevant checks below.

## Page translation does nothing

1. Check the main switch and target language.
2. Browser settings and extension stores are protected pages; try an ordinary article.
3. Check the selected service under **Settings → Translation services**. Wait or switch services if it is busy.

## Only part of the page is translated

Scroll down: the default mode translates near your reading position. For missing menus, buttons, or article areas, check [Website reading area](/en/config/site-adaptation). Use [image](/en/guide/image-translation) or [area translation](/en/guide/area-translation) for text inside pictures and charts.

## Selection works, but whole-page translation fails

Try a single paragraph, then check the [reading area](/en/config/site-adaptation). Content recognition or the larger number of page requests can cause this. Also check the service connection and allowance.

## How do I restore the original?

Use the restore-page action in the extension menu. After changing languages, services, or base styles, restore the original before translating again.

## Why does Japanese appear in a Chinese translation?

Check the target language, restore the original, and retry. Clear wrong-language responses trigger a retry or another free candidate; repeated failures are shown instead of cached. Short names, terms, and quotations may retain their original language.

## Can webmail messages be translated?

The older QQ Mail reading page and NetEase 163, 126, and yeah JS6 pages support email-body recognition. Open a message and try page or selection translation; refresh if needed. Compose editors are not treated as message bodies.

If text is still missed, report the domain, page path with parameters such as `sid` removed, browser version, and a redacted screenshot. Do not submit the email or login details.

## Why is there no AI explanation?

Ordinary selection translation provides a translation only. Enable the [reading card](/en/guide/deepseek-harness), choose a configured AI service, select text, and start an action such as an explanation.

## Image translation is still preparing

Local OCR needs a recognition language pack on first use. Follow the download prompt and check the source language. Area translation can use model recognition when enabled and supported. For unreadable images, use a clearer original or a smaller selection.

## No subtitles appeared

Check that subtitle translation is enabled and the video has captions. X videos without captions may use local AI recognition after a model download; some videos cannot be read. See [Video subtitles](/en/guide/video-subtitles).

## Where does my API key go?

Choose the service under **Settings → Translation services**, enter its URL, key, and model, then check the connection. Check account allowance too: a chat subscription may not include API use. Ollama also needs a running local server, a downloaded model, and permission for the extension to connect. See [Translation services](/en/config/translation-engines).

## Duplicate translations or broken layout

Restore the original and disable browser translation or other translation extensions before trying again. If it persists, record the URL, steps, and a screenshot with private content removed.

## Why do translations disappear when Font Rendering is enabled?

Update FluentRead and refresh the webpage. If the conflict remains, temporarily disable the font script’s bold correction and report both versions with a public reproduction URL.

## Where are local translation models stored? Are they cleared on uninstall?

By default, downloaded models live in this browser’s extension cache. If you enable a shared model folder, those files live in the folder you selected; uninstalling or disconnecting does not delete them. You can delete browser-local cached models in settings. Chrome manages its own built-in translation packs. Manually downloaded extension archives and extracted folders need separate cleanup.

## Do local models reload on every request or stay in memory forever?

Downloaded files and runtime memory are different. Local translation, read-aloud, speech recognition, and OCR reuse loaded resources and release them when idle. The usual wait is one minute on known low-memory devices, three minutes on other known devices, or two minutes when memory information is unavailable. Active tasks are not interrupted by the idle timer.

Releasing memory keeps downloaded files for later loading. Several tools can use memory at once, so these times are not hard memory caps. Chrome’s built-in models and Ollama manage their own residency.

## Can I import an older backup?

Import an older configuration JSON or backup under **Settings → Backup and restore → Local backup**, review the preview, and confirm. Full backups may include API keys and are unencrypted; keep them private.

If validation fails, keep the original file, update the extension, and retry. Report only the version and error message if it still fails, without attaching the full backup. See [Backup and sync](/en/config/backup-sync).

## Still need help?

Report browser and extension versions, a public URL, reproduction steps, and a redacted screenshot on [GitHub Issues](https://github.com/FluentRead/FluentRead/issues). Do not provide keys, cookies, or account details.
