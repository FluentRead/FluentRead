# Video & meeting translation

Read original captions and translations in YouTube, X, Udemy, Disney+, and Google Meet, Teams, or Zoom web meetings. Most platforms need readable captions; X also offers local AI transcription.

<GuideVisual kind="video" en />

## A video with subtitles

1. Enable **Video subtitle translation** in the extension menu or settings, and turn on the video's native captions.
2. In YouTube or X, click the FluentRead icon near the fullscreen button.
3. Choose **Bilingual / Translated / Original**. Other supported platforms provide display controls near their captions.

The service follows webpage translation by default; choose a separate one in **Video translation settings**. Selecting **Off** in the player disables video translation and removes its button. Re-enable it from the extension menu or settings.

Translation depends on the selected service's response. Opening a video or seeking to an untranslated section can cause a delay. Retry a failed translation without repeating transcription: recognized source captions and their timeline remain available.

## Meeting captions and human subtitles

Meetings use web clients, including Zoom's `/wc/` client. The platform, host, or account must allow captions. Browser extensions do not control desktop meeting apps.

Two options under **Video translation settings → General** are on by default:

- **Automatically enable bilingual meeting captions** attempts to enable captions supplied by Google Meet, Teams, and Zoom. Enable native captions manually if it fails. Disabling translation or hiding FluentRead captions restores the native display.
- **Prefer human subtitles** uses readable target-language human captions on YouTube, Udemy, and Disney+. Missing or inaccessible portions fall back to translating source captions.

FluentRead does not start meeting recording or transcription, or generate captions for meetings that provide none. Udemy and Disney+ availability also depends on account, region, and player restrictions.

## Display and download

Adjust size, background, position, width, and bilingual order in video appearance settings. Its example only previews styling; it reads no video and sends no requests.

If captions are early or late, open **Subtitle timing** in the player menu (under **Subtitle options** on X). Adjust by **0.5 seconds**, up to **±10 seconds**, or reset to zero. The saved offset applies to later videos and moves both lines together. It does not change playback or exported timestamps. Timing needs an available subtitle timeline.

Click **Download subtitles** in the menu header, then choose **Original / Translated / Bilingual** to save SRT. Bilingual files always put the original first, regardless of display order, and omit duplicate text.

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

Choose **Start sentence learning** in a YouTube/X subtitle menu to read the source sentence, context, and whole-sentence translation. It needs a readable timeline; X AI subtitles must finish first. Long or unpunctuated captions may be labelled as fragments, rather than complete sentences.

- **Previous / Next** seek to original caption boundaries without playing. **Replay** plays from the sentence start.
- **Loop sentence / Pause at end** assist the selected sentence. If playback is outside it, use Replay to start. Manual seeking releases control; your pause and playback speed remain authoritative.
- **Explain** is optional and calls your selection AI explanation service only when requested. It can use neighboring captions if context is allowed.
- **Edit** changes the translation or explanation and pins the sentence. Drafts survive sentence changes during this panel session; return to the current sentence to follow playback again.
- **Save sentence** keeps the source, confirmed translation, explanation, context, and time in the Learning Center. No explanation is required. Wait for a pending translation or enter your own before saving.

With focus in the player, arrows change sentence, R toggles looping, and Q toggles end pause. Text fields keep normal typing; an open subtitle menu takes keyboard priority. Drag the panel title to move it or use its style button to change layout and size. Closing learning or captions, or switching videos, stops playback assistance.

Learning Center sources reopen the video near its original time; X positioning needs the extension enabled. Saved text remains if a video is deleted or restricted. Subtitle offsets and bilingual order do not change the original times used for saving and looping. Vocabulary exports that omit private context also omit video URLs and times.

</details>

## Missing or inaccurate subtitles

Enable platform captions and wait for them to load. Ordinary translation cannot start without captions; on X, try local AI generation instead.

An empty transcription means recognition found no readable speech. Check the audio and source language, or try Small instead of Tiny/Base. For a translation failure, retry or change translation services. Check important information against source captions and audio.

## Related guides

- [Data & privacy](/en/guide/privacy)
- [Troubleshooting](/en/guide/faq)
