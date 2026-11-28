# Video & meeting translation

Read original captions and translations in YouTube, X, Bilibili (regular videos, multi-P, and accessible Bangumi/PGC episodes), Udemy, edX, Coursera, Disney+, Netflix, Amazon Prime Video, TED, Vimeo, and Google Meet, Teams, or Zoom web meetings. You can also import local audio or video files in Video settings for offline AI transcription, bilingual playback, and sentence-by-sentence learning.

<GuideVisual kind="video" en />

## A video with subtitles

1. Enable **Video subtitle translation** in the extension menu or settings, and turn on the video's native captions.
2. In YouTube or X, click the FluentRead icon near the fullscreen button.
3. Choose **Bilingual / Translated / Original**. Other supported platforms provide display controls near their captions.

The service follows webpage translation by default; choose a separate one in **Video translation settings**. Selecting **Off** in the player hides FluentRead subtitles while keeping its icon so you can re-enable them later.

To switch subtitle modes from the keyboard without clicking the player icon, enable **Subtitle mode shortcut** under **Video translation settings → General** (default `Alt+M` / `Option+M`, with presets and custom shortcut recording) and choose **Bilingual ↔ Original**, **Cycle (Bilingual → Translated → Original)**, or **Cycle all (including Off)**. The shortcut automatically yields while typing in input fields.

Translation depends on the selected service's response. Opening a video or seeking to an untranslated section can cause a delay. Retry a failed translation without repeating transcription: recognized source captions and their timeline remain available.

## Streaming platforms & Bilibili Bangumi/PGC

- **Netflix** (`netflix.com`): Detects player containers (`.watch-video--player-view`, `.VideoContainer`) and timed-text captions (`.player-timedtext-text-container`, `.player-timedtext`), toggles native subtitle visibility safely, and mounts an isolated display-mode control in the player bar when available.
- **Amazon Prime Video** (`primevideo.com`, and `/gp/video/` or `/detail/` pages on `amazon.com`, `amazon.co.jp`, `amazon.co.uk`, and `amazon.de`): Reads player captions (`.atvwebplayersdk-captions-text`, `.f35bt6a`) and anchors a safe mode switcher inside the player control bar.
- **TED** (`ted.com`): Supports native caption overlays, HTML5 `<track>` cues, and active transcript cues on talk pages, with safe control-bar mode switching.
- **Vimeo** (`vimeo.com`, `player.vimeo.com`): Reads `.vp-captions` / `.vp-telecine` captions and `<track>` cues with a control-bar toggle anchor.
- **Bilibili Bangumi / PGC** (`bilibili.com/bangumi/play/...`): Recognizes `ep` and `ss` episode paths alongside normal/multi-P videos where captions or unencrypted AAC audio are accessible, without bypassing DRM or browser security boundaries.

All platforms follow non-invasive DOM ownership and restore native captions and clean up listeners, observers, and mounted controls on mode off, disable, SPA navigation, or unload.

## Local audio & video import with offline AI transcription

Under **Video translation settings → Local AI subtitles**, the **Local audio & video transcription** studio lets you drag and drop or pick local files (`.mp4`, `.webm`, `.mp3`, `.m4a`, `.wav`, `.ogg`, `.flac`; up to **200 MB** and **20 minutes**):

1. Files are validated and decoded locally via the Web Audio API into 16 kHz mono PCM — audio never leaves your device.
2. Offline recognition reuses FluentRead's configured **Whisper in the browser** model or **Local Qwen3 ASR** protocol with full cancellation support.
3. Recognized cues are translated via your configured FluentRead translation service (skipping cues already in the target language, with retry for failed items) and played back with synchronized **Bilingual / Translated only / Original only / Off** captions.
4. Built-in **Sentence learning & loop** lets you jump by sentence, step previous/next, replay, **loop a single sentence**, or **pause at sentence end**.
5. Export **SRT, WebVTT, or Markdown** in bilingual, original, or translated mode. Clearing, switching files, or closing the panel aborts active work and revokes temporary object URLs.

## Meeting captions and human subtitles

Meetings use web clients, including Zoom's `/wc/` client. The platform, host, or account must allow captions. Browser extensions do not control desktop meeting apps.

Two options under **Video translation settings → General** are on by default:

- **Automatically enable bilingual meeting captions** attempts to enable captions supplied by Google Meet, Teams, and Zoom. Enable native captions manually if it fails. Disabling translation or hiding FluentRead captions restores the native display.
- **Prefer human subtitles** uses readable target-language human captions on YouTube, Udemy, and Disney+. Missing or inaccessible portions fall back to translating source captions.

FluentRead does not start meeting recording or transcription, or generate captions for meetings that provide none. Udemy and Disney+ availability also depends on account, region, and player restrictions.

## Display and download

Adjust size, background, position, width, and bilingual order in video appearance settings. Its example only previews styling; it reads no video and sends no requests.

If captions are early or late, open **Subtitle timing** in the player menu (under **Subtitle options** on X). Adjust by **0.5 seconds**, up to **±10 seconds**, or reset to zero. The saved offset applies to later videos and moves both lines together. It does not change playback or exported timestamps. Timing needs an available subtitle timeline.

Click **Download subtitles** in the menu header, then choose **Original / Translated / Bilingual** to save SRT. Each bilingual cue puts the original on the first line and the translation on the second. Identical lines appear once. The bilingual export uses a single timeline. An overlapping cue ends when the next one starts, and cues that start together share one entry.

Translated or bilingual exports first show how much text still needs translation and its time span:

- **Translate missing text and export complete subtitles** requests missing translations only after confirmation. Usage follows your selected service.
- **Export available results only** skips untranslated cues, adds `partial` to the filename, and reports how many were skipped.

Close the menu or press Esc to cancel while translating missing text; completed translations remain reusable. Changing the video or translation settings requires a new preview. X AI subtitles become exportable only after complete recognition succeeds.

<details class="guide-details">
<summary>An X video without subtitles</summary>

## An X video without subtitles

The desktop Chrome, Edge, and Firefox extensions use Whisper in the browser by default to transcribe X videos.

1. Open the X player's FluentRead menu and choose to generate AI subtitles.
2. For Whisper in the browser, select and confirm a model download on first use. **Small** is recommended (about 590 MB). **Tiny** (about 100 MB) and **Base** (about 150 MB) use less storage.
3. Wait while the extension reads and transcribes the audio. You can stop at any time. Stable sentences appear early, and the timeline is cached and becomes exportable after recognition succeeds.

All Whisper models support multiple languages. Use **Auto** when the language is unknown or changes, or specify a known single language. Whisper in the browser uses available GPU acceleration and falls back to CPU. FluentRead sends recognized text to your translation service according to the display mode. Original-only mode displays the transcript locally.

The limit is **20 minutes per video**. Speed depends on the video and device. Some media formats or restricted videos cannot be read; try opening the post or refreshing. Quiet speech, music, accents, and specialist terms can affect accuracy.

Use **Subtitle options → Recognition model / Regenerate this video** to change models or recognize again. Existing captions remain until confirmation; cancel preserves them. Stop an active download or recognition before switching models. Regeneration does not require clearing other videos' caches.

Manage Whisper models under **Video translation settings → Local AI subtitles**. The first download requires a connection. Retry failed downloads to reuse complete files and fill missing ones. Clearing browser caches can require downloading again. A recognition failure removes incomplete previews, while a translation failure preserves the recognized source.

Browsers that support the File System Access API can also enable **Share models across browsers**. Select and authorize the same folder in each browser; models are stored in its `FluentRead/whisper` subfolder. Existing models can be moved there. Disconnecting does not delete shared files. Browser-local extension caches remain available.

### Use Local Qwen3 ASR

If you have vLLM with support for this model, run the command below to start a local service. It must serve the fixed model `Qwen/Qwen3-ASR-1.7B` at `POST /v1/audio/transcriptions` without credentials. [vLLM model recipe](https://github.com/vllm-project/recipes/blob/main/models/Qwen/Qwen3-ASR-1.7B.yaml)

```sh
vllm serve Qwen/Qwen3-ASR-1.7B --host 127.0.0.1 --port 8000
```

In **Video translation settings → Local AI subtitles → Recognition method**, choose **Local Qwen3 ASR**, enter `http://127.0.0.1:8000`, and save. The address must use `127.0.0.1` or `[::1]`. Once the service is running, select **Generate AI subtitles** on an X video with a readable audio track. This sends the audio to your local service.

FluentRead estimates caption timing from audio windows. Stopping cancels the extension's request, and the server may continue processing audio it already received. If the service fails, retry or switch back to **Whisper in the browser** in settings.

</details>

<details class="guide-details">
<summary>Reading annotations and word highlighting</summary>

## Reading annotations

In the browser extension, enable **Video appearance → Reading annotations** or its header icon in the YouTube/X menu. It is off by default and unavailable in the userscript. Supported readings include Japanese romaji, Korean romanization, Chinese pinyin, and Latin transliteration for Russian, Greek, Arabic, Hindi, and Thai.

Readings follow the original text and stay hidden in translation-only or hidden-caption modes. Enabling them does not change display mode. Japanese first needs about **17.8 MB** of dictionary data, Hindi about **0.5 MB**. Verified data is cached locally for offline reuse; retry failed downloads in the menu. Captions are not sent to a reading service, and originals and translations can display while data is prepared.

Readings are aids, and names, alternate pronunciations, and sound changes can be wrong. Check the audio. Annotations do not change source captions or exports.

### Word-by-word highlight

Enable **Word-by-word highlight** in video appearance settings (off by default) to light up YouTube and X captions as they play. Timing is estimated from the whole cue's duration and text length, so it may differ from actual pronunciation.

</details>

<details class="guide-details">
<summary>Sentence learning</summary>

## Sentence learning

Choose **Start sentence learning** in the subtitle menu on YouTube, X, Bilibili, Udemy, or edX. The browser extension can replay and save sentences once a complete subtitle track is available. Its downloads menu exports original, translated, or bilingual **SRT, WebVTT, and Markdown**. It asks before translating any missing captions. Long or unpunctuated captions may appear as fragments.

On Coursera lecture pages that expose a readable WebVTT track, enable **Bilingual** or **Original only** in the FluentRead player menu. The complete track is then available for replay, saving and download. Coursera manages access to the lecture.

The learning panel splits existing captions into sentences using local rules. Each sentence keeps its source text and original caption timing. Sentences from the same caption can share a playback range, so moving between them keeps your current position.

- **Previous / Next** select the adjacent sentence. Moving to a different source passage seeks to its start and preserves the current play or pause state.
- **Replay source passage** plays from the start of the passage. **Loop source passage / Pause at passage end** follow the original caption timing. If the playhead is outside the range, use Replay to start. Manual seeking ends playback assistance and preserves your playback speed.
- **Explain** is optional and calls your selection AI explanation service only when requested. It can use neighboring captions if context is allowed.
- **Edit** changes the translation or explanation and pins the sentence. Drafts survive sentence changes during this panel session; return to the current sentence to follow playback again.
- **Save sentence** keeps the source, confirmed translation, explanation, context, and time in the Learning Center. No explanation is required. Wait for a pending translation or enter your own before saving.

With focus in the player, arrows change sentence, R toggles looping, and Q toggles pause at passage end. Text fields keep normal typing; an open subtitle menu takes keyboard priority. Drag the panel title to move it or use its style button to change layout and size. Closing learning or captions, or switching videos, stops playback assistance.

Learning Center sources reopen the video near its original time; X positioning needs the extension enabled. Saved text remains if a video is deleted or restricted. Subtitle offsets and bilingual order do not change the original times used for saving and looping. Vocabulary exports that omit private context also omit video URLs and times.

</details>

## Missing or inaccurate subtitles

Enable platform captions and wait for them to load. Ordinary translation cannot start without captions; on X, try local AI generation instead.

An empty transcription means recognition found no readable speech. Check the audio and source language, or try Small instead of Tiny/Base. For a translation failure, retry or change translation services. Check important information against source captions and audio.

## Related guides

- [Data & privacy](/en/guide/privacy)
- [Troubleshooting](/en/guide/faq)
