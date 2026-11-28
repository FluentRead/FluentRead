# Video & meeting captions

Watch videos, online courses, web meetings, and standard HTML media with bilingual captions—complete with mode shortcuts, timing sync, phonetic guides, sentence study, subtitle export, and local AI speech transcription when captions are missing.

<GuideVisual kind="video" en />

<DocDiagram kind="video-matrix" en />

## Videos with native captions {#videos-with-captions}

1. Confirm **Video subtitle translation** is enabled in the menu or settings, and turn on native captions in the video player.
2. Click the **FluentRead icon** in the player control bar (usually beside the CC or fullscreen button).
3. Select **Bilingual / Translation / Original**, or choose **Off** to hide captions while keeping the toolbar icon accessible (disable the global switch in Settings to hide the icon itself).

### Shortcuts & listening practice

- **Mode shortcut:** Enable **Caption display shortcut** under **Video translation → General** (default `Alt+M` / `Option+M`, customizable) to toggle **Bilingual ↔ Original** or cycle modes—automatically yields inside comment/search inputs.
- **Listening drill without duplicate API calls:** Cycling **Off → Original → Bilingual → Off** keeps completed translations cached; native captions stay cleanly hidden while FluentRead is active.

### Supported video & course platforms

| Platform | Caption behavior & notes |
| --- | --- |
| **YouTube** | **Prefer human captions** (on by default) uses existing target-language human tracks directly; Original mode shows clean full-cue lines instead of word-by-word scrolling |
| **Bilibili (Standard / Multi-P)** | Prefers uploader human captions, then platform AI captions (login required); supports local AI transcription when empty; manual start by default (configurable per site); bangumi excluded |
| **X (Twitter)** | Translates native captions; supports on-device Whisper or local Qwen3 ASR when captions are missing |
| **Udemy / Udemy Business** | Prefers instructor original-language tracks; auto-starts by default and re-binds cleanly across lectures |
| **edX / Coursera** | Supports HTML5 players with readable subtitle tracks, including sentence study and export (embedded YouTube players excluded) |
| **Disney+** | Translates readable caption tracks subject to account, region, and player restrictions |

## Live web meeting captions {#meeting-and-human-captions}

Supports web clients for **Google Meet**, **Microsoft Teams**, and **Zoom (`/wc/`)** (desktop meeting apps are outside browser-extension control):

- **Auto-enable bilingual captions on meeting platforms** is on by default under **Video translation → General** (requires host/account caption permission; toggle native captions manually if needed).
- FluentRead **never** starts meeting recording or cloud transcription and cannot synthesize captions if the platform does not provide them.

## Missing captions & HTML audio/video (Local AI ASR) {#html-audio-and-video}

When **X videos**, **Bilibili standard/multi-P videos**, or standard webpage `<audio>` / `<video>` elements lack native captions, open the player’s FluentRead menu and click **Generate AI captions** (audio capture never starts automatically):

- **Direct local decode (up to 20 minutes):** Readable MP3, M4A, WAV, OGG, MP4, WebM, and Bilibili AAC DASH tracks decode locally window by window, displaying stable sentences as they finish.
- **Playback capture (streams / >20 min):** HLS, MSE/blob, live streams, or longer media capture the active audio track on HTTPS/localhost in AudioWorklet-capable browsers. Play at **1× speed** (up to 20 minutes per run) and click **Stop** to finalize; seeking or changing speed ends the capture and exports are labeled `partial`.
- **Protected media:** DRM-protected streams, CORS-blocked media, and closed Shadow DOM players cannot be transcribed; FluentRead does not bypass browser restrictions.

## Styling, timing sync & subtitle export {#appearance-and-saving-captions}

- **Live appearance preview:** Adjust font size, outline, color, width, position, bilingual order, and background visibility in **Video subtitle appearance**.
- **Timing offset (±10 s):** Adjust **Subtitle timing** in **±0.5 s** increments (up to `±10 s`, with one-click reset). Offsets save persistently and shift both lines without modifying exported timestamps.
- **Export SRT / WebVTT / Markdown:** Click the download icon in the player menu and pick **Original / Translation / Bilingual**:
  - Translation/bilingual exports preview missing cues first so you can choose **Translate missing & export full** or **Export available only** (`partial`).
  - Bilingual SRT uses a clean single-track timeline with original above translation and duplicate lines collapsed.

<details class="guide-details">
<summary>Local Whisper models & local Qwen3 ASR setup</summary>

### In-browser Whisper models

1. Manage models under **Video translation → Local AI captions**: **Small** (~590 MB) is recommended; lighter **Tiny** (~100 MB) and **Base** (~150 MB) are also available (all multilingual with auto-detect).
2. First download requires internet and resumes cleanly if interrupted; inference prefers GPU and falls back to CPU automatically.
3. Browsers supporting the File System Access API can enable **Share models across browsers** (`FluentRead/whisper` folder).
4. Switch models or choose **Re-transcribe this video** anytime from **Caption options** without clearing other cached videos.

### Local Qwen3 ASR (vLLM)

Run a local unauthenticated vLLM server exposing `POST /v1/audio/transcriptions` for `Qwen/Qwen3-ASR-1.7B` ([vLLM recipe](https://github.com/vllm-project/recipes/blob/main/models/Qwen/Qwen3-ASR-1.7B.yaml)):

```sh
vllm serve Qwen/Qwen3-ASR-1.7B --host 127.0.0.1 --port 8000
```

Select **Local Qwen3 ASR** under **Video translation → Local AI captions**, enter `http://127.0.0.1:8000` (loopback `127.0.0.1` or `[::1]` only), and save.

</details>

<details class="guide-details">
<summary>Phonetic guides & word-by-word highlighting</summary>

### Phonetic guides

Enable under **Video subtitle appearance → Phonetic guides** or from the YouTube/X menu icon (off by default; browser extension only). Supports Japanese romaji, Korean romanization, Chinese pinyin, and Latin transliteration for Russian, Greek, Arabic, Hindi, and Thai.

First use caches local dictionaries (~**17.8 MB** for Japanese, ~**0.5 MB** for Hindi) for offline reuse; subtitle text is never sent to a phonetic server.

### Word-by-word highlight

Enable **Word-by-word highlight** in appearance settings to light up words along playback on YouTube and X (estimated from cue timing and text length).

</details>

<details class="guide-details">
<summary>Full-sentence study panel & shortcuts</summary>

### Full-sentence study

Once full captions load on YouTube, X, Bilibili, Udemy, edX, Coursera, or HTML media, click **Start sentence study** in the menu:

- **Shortcuts:** `← / →` switch sentences, `R` loops the source segment, `Q` toggles pause-at-end (yields in inputs and open menus).
- **On-demand AI & editing:** Click **Explain** to call your selection AI provider; click **Edit** to refine translation or notes.
- **Save with timestamp:** **Save sentence** stores the quote and video timestamp in [Learning Center](/en/guide/vocabulary-book) so you can jump back later.

</details>

## Troubleshooting

- **No captions appear:** Enable native captions in the player first, or use local AI transcription where supported.
- **“No readable captions recognized”:** Check for clear speech, confirm source language, or upgrade Whisper from Tiny/Base to **Small**.
- **Translation failed:** Original captions and timing stay intact—simply retry or switch caption provider without re-transcribing audio.

## Related guides

- [Learning center](/en/guide/vocabulary-book)
- [Privacy policy](/en/guide/privacy)
- [Troubleshooting & FAQ](/en/guide/faq)
