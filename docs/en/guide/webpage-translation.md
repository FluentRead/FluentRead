# Webpage translation

Translate an article or a selected section, compare both languages, and return to the original.

<TranslationDemo en />

## Page translation

1. Open an article and click the FluentRead icon in the browser toolbar.
2. Choose the target language and translation service, then click **Translate this page**.
3. Read in bilingual mode, or select **Translation only** to focus on the result. Click **Restore original** to return to the page as it was.

The default translates as you read. If you need the whole page at once, change the translation range in settings. After restoring, you can translate again with another language or service.

| What you want | What to use |
| --- | --- |
| Compare the translation with the original | Bilingual display |
| Read only the translated text | Translation-only display |
| Translate one part of the page | Section translation below |
| Return to the original page | Restore original |

<figure class="doc-figure"><a href="/screenshots/en/translation.webp" target="_blank" rel="noopener"><img class="doc-screenshot" src="/screenshots/en/translation.webp" width="2560" height="1600" alt="Chinese paragraphs followed by English translations on the same webpage" loading="lazy" /></a><figcaption>Keep the original nearby when a name or detail needs a second look.</figcaption></figure>

### Page floating ball

Enable **Full-page translation ball** under **Settings → General → Page helpers** to show a shortcut at the edge of the page: click it to translate the whole page, click again to restore the original, and hold it to drag the ball up or down — it docks to the nearer side with space for the page scrollbar when you release it.

You can also search settings for “Full-page translation floating ball” to jump to the switch, or search for “Floating ball advanced settings” to jump to its display, position, and site options.

**Floating ball advanced settings** tunes the rest:

- **Button display**: show the translate and settings buttons on hover, always, or hide them and keep the ball alone.
- **Expand delay**: how long the pointer has to rest before the buttons expand. It is immediate by default; a longer delay avoids accidental expansion when the pointer crosses the edge of the page. Keyboard focus always expands immediately.
- **Click action**: clicking the ball itself can toggle translation, open the settings page, or do nothing. Holding it always drags.
- **Smaller ball**: use a reduced size so the ball covers less of the page.
- **Settings entry**: hide the button that opens the settings page from the ball.
- **Collapsed opacity**: lower values are more transparent. Hovering, expanding, and dragging always render the ball fully.
- **Sites without the ball**: add a registrable domain to hide the ball on that site and its subdomains. Shortcuts, the context menu, and every other feature keep working.

Turning the ball off leaves the full-page translation shortcut (Alt+T by default) and the context menu entry untouched.

## Section translation

When you only want to read part of a page, such as a GitHub README, an article body or one comment thread, you don’t have to translate the whole page. Click the **Section** button next to **Translate this page** in the extension menu to start picking:

- The part of the page under the mouse is outlined, and a label tells you what a click will do: how many paragraphs it will translate, that it will show the original again, or that there is nothing to translate.
- Click to translate just that section. Paragraphs on screen are translated first and the rest follow. Display mode, service and target language are the same as for page translation.
- Press **↑** to widen the section to its outer container and **↓** to narrow it again. After widening, the selection stays put while the mouse is inside the outline.
- Pick a translated section again to show its original text. If some paragraphs failed, picking the section again retries them.
- Press **Esc**, right-click, or click **×** on the hint bar at the bottom to exit. While picking, clicks on the page don’t open links or press buttons.

If you use it often, turn on its shortcut in **Settings → Translation → Section translation** (default **Alt+R**, Option+R on a Mac); press it again while picking to exit. Headers, navigation and sidebars usually stay in the original language during page translation, but if you pick one of them yourself, its text is translated too and, like other interface text, replaces the original in place so the layout stays intact. Restoring page translation also restores any translated sections.

## Automatic translation and site rules

Translate a frequently visited site automatically, or keep a particular site in its original language. For missing article text, start with [website reading area](/en/config/site-adaptation).

## More translation languages

Source and target selectors now offer 52 language options, including Simplified and Traditional Chinese, German, Portuguese, Italian, Arabic, Hindi, Vietnamese, Thai, Ukrainian, and Swahili. Input translation and the writing assistant share the same list. Automatic source detection remains available, and existing language settings are preserved.

Choose a translation service that supports your language pair. Language coverage varies between machine translation services, AI models, and Chrome built-in translation; a listed language is not a guarantee of support from every service. Image OCR and video speech recognition still depend on their own language packs or models.

DeepL currently does not support Kannada or Sinhala; selecting either prompts you to choose another service. Norwegian codes for Google and NiuTrans, and Serbian codes for Microsoft, are converted automatically.

::: details Page recognition and compatibility

Open FluentRead and choose the page translation button. In bilingual mode, each translation sits beside its original paragraph, and the original keeps its headings, links, and article structure. Paragraphs split only by links, bold, italics, or footnote markers are translated as a single unit and shown as one readable passage, so a sentence is never broken apart by inline formatting; machine translation services receive one request per such paragraph instead of one per fragment. Paragraphs with inline code, formulas, or images are still translated fragment by fragment so those elements stay intact in the translation. Common inline formulas are preserved where supported.

When you open a raw XML, RSS, or SVG file directly, FluentRead leaves the document untouched so the browser can display it normally. HTML and XHTML pages remain translatable.

By default, translation follows your reading position. Choose whole-page processing in settings if you want the entire page translated at once. Restore the original whenever you like, then translate again with another language or service.

Fixed-height cards and line-clamped summaries expand while bilingual text is shown, so the translation stays visible without overlapping the next card. Restoring the original also restores the page's height and truncation styles; independent scroll areas keep their original behavior.

When an announcement or modal dialog blocks the page, full-page translation handles the active dialog first and automatically continues with the page after you close it. A dialog that appears during translation pauses unfinished page tasks while preserving existing translations. If progress feedback is enabled, it explains that translation will continue after the dialog closes. Restoring the original also cancels this automatic continuation. Non-blocking notices and panels do not pause the page.

#### Buttons show the translation only

Buttons, tabs, form labels and toolbar actions are interface controls whose size is fixed by the site's own styling. In bilingual mode this text is **replaced by the translation instead of stacked with the original**, so a button is never pushed taller, its label never overflows, and a toolbar row never breaks apart. Native buttons, elements with a control `role`, button-styled links and buttons built from input elements all follow the same rule. Restoring the original text puts the original labels back.

Full sentences in paragraphs, headings and disclosure sections still follow the display mode you picked, so bilingual reading is unaffected.

Buttons that are submitted with a form (submit buttons that carry a `name`) and the contents of text fields are left untouched, so the site never receives an action it cannot recognise and your own input is never rewritten.

#### Missing menus or interface text

In **Advanced settings → Page recognition**, enable the option to recognize all nodes, restore the page, and translate again. It can include visible menus and navigation added while translation is active.

A wider scope also changes more interface text. Turn it off to return to the usual scope on the next translation. For text drawn inside pictures or charts, use [images](/en/guide/image-translation) or [area translation](/en/guide/area-translation).

#### Times, numbers and changing content

Standalone dates, clocks, durations (such as `12:34 PM`, `5 minutes`, and `1h 2m 3s`) and numeric values stay original and are excluded from translation requests. Normal sentences containing these values remain translatable. Time displays marked with `<time>` or `role="timer"` also stay original.

When source text changes, full-page translation waits for about 1.8 seconds of stability before translating the latest content. Short labels whose numbers change repeatedly, such as counters and progress, stay original. New content at the same location can be translated again. Hover translation uses the same rules; trigger it again after changing content has settled.

#### Tune how paragraphs are handled

**Advanced settings** offers a few more controls over webpage translation. Each one applies from the next translation:

- **Sidebar translation**: also translate sidebars and navigation while reading main content; headers and footers stay untouched.
- **Minimum characters per paragraph**: skip paragraphs shorter than this length to cut requests for tiny fragments. Length counts characters, so `hello` counts as 5.
- **Characters translated without scrolling**: translate this many characters from the top of the page right away; the rest follows your reading progress. Set it to 0 to rely on the viewport alone.
- **Line breaks in long paragraphs**: insert a line break at the end of each sentence in long translated paragraphs.
- **Translation before original**: in bilingual mode, place the translation above each original paragraph instead of below it.


:::

## Next steps

- [Appearance](/en/config/appearance)
- [Shortcuts](/en/guide/custom-hotkey)
- [Troubleshooting](/en/guide/faq)
