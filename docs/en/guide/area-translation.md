# Area translation

Draw around a screenshot, chart or paused video frame on a webpage to recognize and translate its text.

<GuideVisual kind="area" en />

## Select an area

1. Enable area translation under **Image translation → Area translation**, then choose the recognition method and translation service.
2. Press **Shift+Z** once, drag around the area and release the pointer.
3. Wait for recognition and translation. Move the result card, copy the translation, expand the original or view the capture.

If a local language pack is missing, select **Download language pack and retry** to continue with the same capture after downloading. Choose **Reselect** for another area, or **Retranslate** to reuse the capture after changing services. Press **Esc** to exit.

Scrolling or resizing keeps a completed capture available. Moving the page before capture finishes cancels the old selection. Switching tabs closes the result and releases the capture.

## Choose a recognition method

| Method | What happens | What you need |
| --- | --- | --- |
| Prefer model vision (default) | Send the cropped selection to an image-capable model; use local recognition when capability is unsupported or unconfirmed | An image-capable service and model, or local language packs |
| Local OCR | Recognize text on your device, then send the recognized text for translation | Packs matching the source language, shared with [image translation](/en/guide/image-translation) |

Choose an area-specific service, or leave it following the webpage default. Editing a provider's connection does not select it for translation. The result card shows the recognition method, provider and model actually used.

Models can misread blurred or handwritten text; compare the capture with the recognized text. Network, key and quota failures remain visible errors rather than silently switching recognition methods.

## Standard or AI text enhancement?

**Standard translation** directly translates recognized text and suits clear, simple layouts.

**AI text enhancement** uses a general AI service to tidy broken lines and translate. It only sees recognized text and cannot recover characters that recognition missed. It works with either recognition method.

## Availability and data

Area capture is supported in Chrome, Edge, and Firefox extension versions with capture capability. Browser internal pages, restricted videos or unreadable areas may not be captured. Other versions explain their available capabilities.

Local OCR keeps the image on your device and sends only recognized text for translation. Model vision uploads the cropped selection, followed by text translation through the same service; it does not upload the full screen. Recognition requests are excluded from the translation cache, and closing the card releases the temporary capture.

Use [image translation](/en/guide/image-translation) to read a translation directly on a whole image.

<details class="guide-details">
<summary>Change the shortcut</summary>

## Change the shortcut

Choose a preset or record a custom combination under **Image translation → Area translation → Area translation shortcut**. A letter must be combined with Ctrl, Alt/Option or Shift. Resolve conflicts with other features before saving. Canceling keeps the previous shortcut.

The shortcut does not run in input fields or editable areas.

</details>

<details class="guide-details">
<summary>Test model vision and edit its prompt</summary>

## Testing image recognition

The first use of an unknown model tests it with a small locally generated image containing random characters, never a webpage capture. You can also select **Translation services → Model preferences → Test image recognition**, or manually set the model to image-capable or text-only. Testing may incur model usage charges and can be canceled.

Only an exact reading confirms image support. HTTP 200 or a successful text connection does not prove vision capability. Results stay on this device for seven days; changing the service, model or connection requires a new result. Test images, answers and credentials are not stored or included in backups. Manual overrides take priority.

With model vision enabled, edit or restore the recognition prompt to preserve tables, formulas or symbols. This changes transcription only, not webpage translation. Subsequent text translation still uses the provider's existing settings.

</details>

## Recover from an error

The card highlights the next action: prepare a missing OCR language pack, reselect an area with no recognized text, check service settings, or retry using the same capture. **Other actions** keeps the alternative controls available. Expand **View details** for the original error. Closing the card cancels the pending request.

## Related guides

- [Image translation](/en/guide/image-translation)
- [Troubleshooting](/en/guide/faq)
