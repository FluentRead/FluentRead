# Video & meeting translation

Follow YouTube and X videos or Google Meet, Teams and Zoom web meetings with bilingual captions, using accessible captions provided by the platform.

<GuideVisual kind="video" en />

## A video with subtitles

1. Make sure video subtitle translation is enabled.
2. Open a YouTube or X video and find the FluentRead icon just before the fullscreen button. On X, it stays between picture-in-picture and fullscreen when controls reappear or fullscreen changes.
3. Choose bilingual, translation-only, or original-only display.

FluentRead uses subtitle tracks or subtitle text provided by the page. It cannot guarantee translations where no subtitles are available. The subtitle translation service follows the webpage service by default; you can select a separate service in video translation settings.

<details class="guide-details">
<summary>Caption timing and pretranslation</summary>

When a YouTube or X subtitle timeline is available, FluentRead prioritizes the current caption and pretranslates up to eight distinct upcoming texts. The window normally covers the next 10 seconds for machine translation or 30 seconds for AI services, and expands for faster playback. Native tracks start prefetching as soon as they load. Repeated entries and expired captions do not consume upcoming slots, and seeking updates the prefetch window.

The subtitle menu also works in YouTube fullscreen. Prefetched originals and translations appear together in the same update. Previous translations clear when captions change, disappear, or you seek. At startup, after seeking to an untranslated position, or while the service is still responding, the original remains available; the translation is added only while its caption is still current.

On X, bilingual lines always appear together. A caption without a ready translation waits for the matching result while playback continues; expired results are discarded. Original-only mode displays immediately. If translation fails, the current original remains available and the menu offers a retry.

When X provides a readable native subtitle track, incoming subtitle fragments preserve the current captions and completed translations, avoiding flicker from repeated source changes near the start of playback.

For YouTube rolling captions, FluentRead matches the newly appearing sentence and playback time to prefetched translations without waiting for the previous line to scroll away. When no subtitle timeline is available, it also submits text during continuous updates. Translation speed still depends on the selected service.

To correct captions that are late or early, open **Subtitle timing** in the FluentRead menu on the playback page and click **0.5 s earlier / 0.5 s later**. Negative values advance subtitles; positive values delay them, up to ±10 seconds. **Reset timing** returns to zero. The setting is saved for subsequent videos and moves both subtitle lines together. Playback position and downloaded subtitle timestamps stay unchanged. The menu indicates when timing adjustment is unavailable.

</details>

<details class="guide-details">
<summary>An X video without subtitles</summary>

## An X video without subtitles

The desktop Chrome / Edge extension can try local AI transcription:

1. Choose a speech model when generating subtitles or use **Subtitle options → Recognition model** in the player. Small is recommended for multiple languages, with an initial download of about 590 MB. Tiny (about 100 MB) and Base (about 150 MB) remain available for lighter devices. The model card in video settings shows a progress bar, percentage and downloaded size. Extra runtime files may be needed later.
2. Return to the X player and choose to generate AI subtitles.
3. Audio reading and recognition progress appear in the player menu. You can stop the job. Completed sentences appear while later windows are still being recognized, and translations are fetched near the playback position. The full timeline is cached and can be exported as SRT only after recognition succeeds; a later recognition failure clears the incomplete preview. Original-only mode does not request translations.

All three models support multiple languages. **Spoken language → Auto** detects the language again for every speech window, so later speech is not locked to the opening language. You can still specify a known single language. Existing model choices and downloads are preserved. Base and Small allow more decoding capacity for text and timestamps; Tiny keeps a shorter budget to limit poor long output. Repeated decoding output is retried once with stronger repetition controls; if it remains corrupt, the job reports an error rather than displaying or caching it.

The model selector keeps the current model selected. Cancel or press Escape to return without changing existing subtitles. Confirm to save the choice and recognize the video again; cached models do not need another download. Model selection is disabled during recognition or downloading. Completed sentences can appear as a preview while recognition continues, and export becomes available when the complete transcript is ready.

Model status checks the complete file list in the local cache. If the browser removes some files, the download action becomes available again; confirming it reuses the remaining files and downloads the missing ones. A cache read failure is shown separately. Reopen settings or return to the page to check again.

Audio recognition runs locally; recognized subtitle text still goes to your translation service. Model downloads require a network connection. Processing depends on video length and your computer. Videos up to 20 minutes are supported; some formats or restricted media cannot be read.

Model downloads try ModelScope first, then Hugging Face and two mirrors after connection or transfer failures. Existing files are reused. Speech models are downloaded separately from the extension package.

Moving the pointer away and back, rebuilding playback controls, temporarily hiding the video, or attaching its thumbnail preserves the AI timeline and pending model request. A completed model download still starts recognition when the same video gains media metadata. A different media identity clears the previous video’s state.

You can generate subtitles directly from the Home feed. FluentRead recovers loaded audio manifests for the current media without mixing other preloaded posts. It prefers the master playlist’s audio rendition and checks the initialization segment for an audio track before downloading media segments. Reading or decoding failures try alternate audio renditions and a lower bitrate complete MP4 belonging to the same video. Candidates come from loaded media and video metadata; the extension extracts only media URLs and bitrates. It requires a confirmed media identity before using metadata candidates. If audio remains unavailable, the menu suggests opening the post or refreshing the page and retrying. Switching videos clears the previous video’s error, progress and model prompt.

Recognition skips digital silence and keeps quiet speech and short spoken tails. Long pauses do not cause the whole speech track to be skipped. Full recognition preserves recognized short phrases and continuations across windows. Trimming long silent edges preserves the original subtitle timing. Long videos prepare audio incrementally, retaining one active window and one waiting window; stopping releases the waiting audio. This does not filter all music or noise, or guarantee accuracy across accents, languages and specialist vocabulary.

</details>

<details class="guide-details">
<summary>Display and download</summary>

## Display and download

Adjust subtitle size, background, position, and width in video appearance settings. X subtitles stay within the video picture, with long lines wrapping inside portrait videos. Their position updates when the player resizes or enters fullscreen, and they try to avoid visible playback controls.

Use the menu to show or hide subtitles and download them. Completed X transcripts are cached locally for a limited time, so reopening the same video usually avoids another transcription. The cached timeline is restored immediately, and bilingual lines appear together as each current translation becomes ready. The cache count refreshes when you return to video settings. Use re-recognition or clear the video cache to start fresh.

</details>

<details class="guide-details">
<summary>Missing or inaccurate subtitles</summary>

## Missing or inaccurate subtitles

Check that subtitles are enabled and the video has a native track. For X AI subtitles, confirm the model download and use Auto when the spoken language is unknown or changes during the video.

An empty transcription is a speech recognition result, separate from a translation failure. Try Small if you are using Tiny or Base. If Small is already selected, check for clear speech and retry. Use Auto when the spoken language is unknown. Audio without speech usually produces no readable subtitles.

Recognition can mishear names or background audio, and translations can be wrong. Check important details against the original subtitles and audio.

Open **Subtitle options → Regenerate this video** to bypass its saved subtitles without clearing other videos or downloading an already installed model again. Existing subtitles remain available until model confirmation. Translation failures keep the recognized original and timeline; use **Retry** to recover without repeating speech recognition.

</details>

<details class="guide-details">
<summary>Supported platforms and default options</summary>

FluentRead also reads captions in Udemy and Disney+ videos and in Teams, Zoom and Google Meet web meetings.

Under **Video translation settings → General**, two options are enabled by default and saved automatically:

- **Automatically enable bilingual meeting captions** attempts to enable available platform captions. You can disable this option and enable native captions yourself. Turning off video translation or hiding FluentRead captions restores the native display.
- **Prefer human subtitles** uses readable human subtitle tracks in the target language on YouTube, Udemy and Disney+. Missing tracks, inaccessible tracks and gaps fall back to translating the original captions. The source track is preserved.

Meeting support applies to browser web clients, including Zoom's `/wc/` client. The platform, host or account must permit captions. FluentRead does not enable recording or transcription and cannot provide speech captions when the platform supplies none. Teams caption activation follows its meeting More actions and Language and speech menus when available; enable captions manually if controls have changed.

Udemy and Disney+ support uses displayed captions and available subtitle tracks. Their caption panel supports bilingual, translation only, original only, off and translation retry, including fullscreen. Track availability can depend on the player, account, region and content restrictions. This feature does not bypass access restrictions or generate audio captions for videos without subtitles.

Read original subtitles and translations together on YouTube and X, or show just one language.

The open subtitle menu stays available when X hides its playback controls. Switches, display modes, and AI subtitle status update as you use them. Click outside, use the close button, or press Esc to close it. Arrow keys move focus inside the menu without seeking the video.

The compact X menu puts display modes first. **Subtitle options** contains timing, downloads, and regeneration; use the back arrow or Esc to return. The source line shows native captions, saved local subtitles, or AI subtitles. Native captions appear as **Loaded subtitles · N cues**. The count changes as the player loads captions and represents the currently loaded cues, rather than the video's final total. When none are detected, it explains how to proceed and disables empty downloads. Native captions take priority over automatically restored AI subtitles; explicitly generated AI captions keep their own timeline.

</details>

## Related guides

- [All guides](/en/docs/)
- [Troubleshooting](/en/guide/faq)

## Settings preview

Video appearance settings show a live sample on the left, with visibility, bilingual or single-language display, skins, size and position on the right. Both work areas have equal width and height on desktop. The compact preview card keeps a 16:9 video frame visible while you scroll through the controls. Narrow screens show the preview above the settings. Fine-tuning controls are directly visible. Hiding subtitles preserves your appearance and translation preferences. The example reads no video and sends no translation requests. X local recognition and model downloads remain in their own section.
