# Webpage and selection translation

FluentRead supports bilingual webpage translation, selection translation, and hover translation. Results appear on the current webpage.

## Page translation

Open FluentRead and choose the page translation button. In bilingual mode, each translation sits beside its original paragraph. Headings, links, and article structure remain available for comparison. Common inline formulas are preserved where supported.

By default, translation follows your reading position. Choose whole-page processing in settings if you want the entire page translated at once. Restore the original whenever you like, then translate again with another language or service.

When an announcement or modal dialog blocks the page, full-page translation handles the active dialog first and automatically continues with the page after you close it. A dialog that appears during translation pauses unfinished page tasks while preserving existing translations. If progress feedback is enabled, it explains that translation will continue after the dialog closes. Restoring the original also cancels this automatic continuation. Non-blocking notices and panels do not pause the page.

<figure class="doc-figure"><a href="/screenshots/en/translation.webp" target="_blank" rel="noopener"><img class="doc-screenshot" src="/screenshots/en/translation.webp" width="2560" height="1600" alt="Chinese paragraphs followed by English translations on the same webpage" loading="lazy" /></a><figcaption>Keep the original nearby when a name or detail needs a second look.</figcaption></figure>

### Page floating ball

Enable **Full-page translation ball** under **Settings → General → Page helpers** to show a shortcut at the edge of the page: click it to translate the whole page, click again to restore the original, and hold it to drag the ball up or down — it docks to the nearer side when you release it.

**Floating ball advanced settings** tunes the rest:

- **Button display**: show the translate and settings buttons on hover, always, or hide them and keep the ball alone.
- **Expand delay**: how long the pointer has to rest before the buttons expand. It is immediate by default; a longer delay avoids accidental expansion when the pointer crosses the edge of the page. Keyboard focus always expands immediately.
- **Click action**: clicking the ball itself can toggle translation, open the settings page, or do nothing. Holding it always drags.
- **Smaller ball**: use a reduced size so the ball covers less of the page.
- **Settings entry**: hide the button that opens the settings page from the ball.
- **Collapsed opacity**: lower values are more transparent. Hovering, expanding, and dragging always render the ball fully.
- **Sites without the ball**: add a registrable domain to hide the ball on that site and its subdomains. Shortcuts, the context menu, and every other feature keep working.

Turning the ball off leaves the full-page translation shortcut (Alt+T by default) and the context menu entry untouched.

### Missing menus or interface text

In **Advanced settings → Page recognition**, enable the option to recognize all nodes, restore the page, and translate again. It can include visible menus and navigation added while translation is active.

A wider scope also changes more interface text. Turn it off to return to the usual scope on the next translation. For text drawn inside pictures or charts, use [images](/en/guide/image-translation) or [area translation](/en/guide/area-translation).

### Tune how paragraphs are handled

**Advanced settings** offers a few more controls over webpage translation. Each one applies from the next translation:

- **Sidebar translation**: also translate sidebars and navigation while reading main content; headers and footers stay untouched.
- **Minimum characters per paragraph**: skip paragraphs shorter than this length to cut requests for tiny fragments. Length counts characters, so `hello` counts as 5.
- **Characters translated without scrolling**: translate this many characters from the top of the page right away; the rest follows your reading progress. Set it to 0 to rely on the viewport alone.
- **Line breaks in long paragraphs**: insert a line break at the end of each sentence in long translated paragraphs.
- **Translation before original**: in bilingual mode, place the translation above each original paragraph instead of below it.

## Selection translation

Enable bilingual selection translation in the extension menu, select a word or passage, and click the nearby icon. Copy the result or read the original aloud. Drag the header or the blank space around the content to move the window, or drag any edge or corner to resize it. Text wraps to fit the width, and long content scrolls inside the card. Your adjustments last until the card closes; a new selection opens at the default size near the selected text.

You can change the trigger to a direct popup, a key, or another gesture, and adjust its delay. A regular translation service is enough for a quick translation.

## Hover translation

Hover over a paragraph and press **Control** to translate it. You don’t need to select text or translate the whole page. See [Shortcuts & triggers](/en/guide/custom-hotkey) to change the behavior.

## AI reading card and learning center

The [reading card](/en/guide/deepseek-harness) can explain tone, unpack a long sentence, show usage, or suggest a practice question. It uses a configured AI service and starts when you choose an action.

Save words, phrases, and sentences to the [learning center](/en/guide/vocabulary-book) to revisit them in context.

## Images, files, and subtitles

- [Images](/en/guide/image-translation): read translated text over the original image.
- [Areas](/en/guide/area-translation): draw around a small part of the screen and get text you can copy.
- [Documents](/en/guide/document-translation): import, read, edit, and download a file.
- [Video subtitles](/en/guide/video-subtitles): use bilingual subtitles on YouTube and X.

## Your service and settings

Use the ready-to-use free service or [connect a provider](/en/config/translation-engines) such as DeepL, an AI service, or a local Ollama model. Supported AI services can also use [glossaries](/en/guide/glossary).

Set regular sites to translate automatically, exclude others, and adjust the [website reading area](/en/config/site-adaptation) when content is missed. Change translation styles, themes, and menu layout in [Settings](/en/config/).

## More translation languages

Source and target selectors now offer 52 language options, including Simplified and Traditional Chinese, German, Portuguese, Italian, Arabic, Hindi, Vietnamese, Thai, Ukrainian, and Swahili. Input translation and the writing assistant share the same list. Automatic source detection remains available, and existing language settings are preserved.

Choose a translation service that supports your language pair. Language coverage varies between machine translation services, AI models, and Chrome built-in translation; a listed language is not a guarantee of support from every service. Image OCR and video speech recognition still depend on their own language packs or models.

DeepL currently does not support Kannada or Sinhala; selecting either prompts you to choose another service. Norwegian codes for Google and NiuTrans, and Serbian codes for Microsoft, are converted automatically.
