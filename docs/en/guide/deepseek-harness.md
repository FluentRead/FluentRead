# Selection translation

Select any word or sentence on a webpage to translate, look up dictionary definitions, listen with multi-source TTS, explore AI explanations, or save to your Learning Center in a single card.

<GuideVisual kind="selection" en />

## Quick start

1. Enable **Settings → Specialized translation → Selection translation**.
2. Drag to select text on a webpage and click the nearby FluentRead icon.
3. The card opens on **Translate**, displaying **Original** above **Translation** with individual copy and read-aloud controls. English dictionary lookup works immediately without configuring AI.

### Card interactions & quick fixes

- **Move & resize freely:** Drag the header or blank margins around text to move the card (dragging across text still copies normally); drag edges to resize. Long content scrolls inside, and the next selection resets to default size near the new selection.
- **Save & share:** Click the top-right buttons to save to [Learning Center](/en/guide/vocabulary-book) or create a [Bilingual share card](/en/guide/share-cards).
- **“Invalid key or permission”:** Click **Configure service** in the card, check credentials under **General → Service assignments → Selection translation → Configure connection**, then return and retry manually.

## On-demand AI explanations

Enable **AI explanations** in selection settings and choose a provider and model. Opening the card never calls AI automatically—choose an action when you want deeper insight:

| Action | What it explains | Free Bilibili service | General AI service |
| --- | --- | --- | --- |
| **Understand** | Core meaning, tone, and contextual references | ✓ Basic | ✓ Full |
| **Parts of speech & syntax** | Sentence backbone, clause roles, and word classes | — | ✓ Full |
| **Usage** | Common collocations and natural expressions | ✓ Basic | ✓ Full |
| **Practice** | Short targeted exercise based on the original | — | ✓ Full |

<GrammarDemo en />

- **Try without an API key:** **Bilibili translation · Free** supports basic **Understand** and **Usage** without a key. Click **Free AI explanations** in the card for the current selection without overwriting your saved AI preferences.
- **Interactive chunks & source quotes:** Click grammar chunks or press `← / →` to inspect roles. Hover end-of-sentence quote markers to inspect original evidence, or click / press `Enter / Space` to jump back to the source sentence.
- **More actions (⋯):** View original, regenerate, expand to full sentence, listen, or open history. Switching tabs reuses completed answers until the source, model, or language changes.

## Multi-source read-aloud & playback controls {#read-aloud-settings}

Configure voices and playback speed (`0.5×–2.0×` with presets) under selection speech settings:

| Speech source | Details |
| --- | --- |
| **Multi-source online TTS (auto-fallback)** | Supports **Edge Neural** (free natural voices), **Youdao** (fast word & phrase audio), **Google TTS** (broadest language coverage fallback), and **OpenAI / compatible TTS** (reuses configured key/proxy; supports `gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`) |
| **On-device local speech (Local only)** | Downloads local voice models to your browser; **Local only** never falls back to online sources |
| **Browser system speech** | Uses OS-provided voices (5-second seek is unavailable for system speech) |

Use the bottom bar to stop, view elapsed time, or skip ±5 seconds with synchronized word highlighting (audio without word timestamps uses estimated progress). Closing the card or changing selections stops playback.

<details class="guide-details">
<summary>Activation modes, auto-dismiss, and two-point selection</summary>

### Activation and display

Choose **Show icon (default)**, **Dot**, **Direct popup**, **Hover icon**, **Shortcut**, or **Context menu only**, and adjust delay under **Activation and display**.

- **Dismiss when continuing to read (on by default):** Scrolling the page, copying original text, or leaving an unopened icon hides it; scrolling or copying inside the card keeps it open. Turn this off to compare while scrolling.
- **Close:** Press `Esc` or click another page control.
- **Hands-free multi-line selection:** Enable [Two-point selection](/en/guide/custom-hotkey#two-point-selection) (`Alt+Shift+S` by default).

</details>

<details class="guide-details">
<summary>English dictionary sources and bidirectional lookup</summary>

### Dictionary and card controls

Under **Selection translation → Translation card → Dictionary source**, **Default (automatic)** queries local entries first and falls back online. You can also select ECDICT, Youdao, Free Dictionary API, Wiktionary, WiktApi, Datamuse, or custom [offline/API dictionaries](/en/guide/dictionaries).

- **ECDICT local dictionary (extension):** Ships with 3,000 common English words out of the box; uncached words trigger a background download of the verified ~3.9 MB full dictionary (download URLs never include your queried word).
- **Bidirectional selection:** When your target language is Chinese or English, automatically translates in reverse based on the selected text’s language.

</details>

<details class="guide-details">
<summary>Context scope, history, and privacy boundaries</summary>

### Context and records

- **Source context:** Limit to **Selection only** or allow a bounded **Current paragraph**—never reads the whole page.
- **Saving & study notes:** **Save original** goes to **Words & sentences** in [Learning Center](/en/guide/vocabulary-book); **Save study note** goes to **Study notes**. **Use study notes in answers** is off by default.
- **30-day local history:** Q&A threads stay on-device for 30 days (viewing does not call AI); private windows do not read or save history. See [Data & privacy](/en/guide/privacy).

</details>

<details class="guide-details">
<summary>Advanced: Chat Completions parameter & token-limit compatibility</summary>

### Chat Completions compatibility

**Understand** and the writing assistant inherit top-level custom request-body fields (such as `service_tier` and `reasoning_effort`) from your chosen Chat Completions provider, while core fields (model, messages, tools, response format, streaming) stay managed by FluentRead. Invalid JSON fails before sending.

Output token limits adapt by endpoint and Azure deployment:
- Official `https://api.openai.com/v1/chat/completions` and Azure GPT-5 / GPT-6 / o1 / o3 / o4 deployments use `max_completion_tokens`.
- Third-party compatible endpoints keep `max_tokens` unless you explicitly set `max_completion_tokens` in the custom body (never sending both).
- Reasoning effort and service tier are forwarded strictly as configured, with no silent fallback or paid retry.

</details>

## Related guides

- [Sentence structure](/en/guide/sentence-analysis)
- [Dictionaries & study cards](/en/guide/dictionaries)
- [Learning center](/en/guide/vocabulary-book)
- [Troubleshooting & FAQ](/en/guide/faq)
