# Area translation

Use area translation for words inside screenshots, charts, paused video frames, or comic bubbles. The result is a card with text you can copy.

## Select an area

1. Enable area translation and choose the recognition mode and translation service. Local OCR requires the matching language pack.
2. Press the area shortcut (**Shift+Z** by default) once, then drag around the area.
3. Release the pointer and wait for recognition and translation.
4. Copy the translation, expand the recognized original, or view the captured area.

If recognition packs are missing, choose **Download language pack and retry**. The required packs download and translation continues using the same capture. You can retry a failed download or press Esc to cancel.

Press **Esc** to exit. Choose a new selection to capture elsewhere, or retranslate to reuse the current capture with a changed service. After capture, scrolling or resizing keeps the result card available for comparison. Scrolling before capture finishes cancels the old selection to avoid recognizing the wrong area. Switching tabs still closes the result and releases the capture; selection mode itself is not cancelled by a page's own scrolling.

## Change the shortcut

In area translation settings, pick a preset under **Area translation shortcut**, or choose **Custom shortcut** and record your own. A single letter needs Ctrl, Alt/Option, or Shift, and a combination already used by hover, page, selection, input-box translation, or a quick translation profile is reported instead of saved. Until a custom recording succeeds, Shift+Z stays in use.

The shortcut never fires inside inputs, text areas, or editable regions, so it cannot interrupt typing.

## Choose a recognition method

**Prefer model vision** is the default. When the selected model supports images, the cropped selection is sent to that model for transcription without an OCR language pack. Unsupported or unconfirmed models use local OCR, and the result card explains why. You can explicitly select **Local OCR** to keep image recognition on your device.

DeepSeek `deepseek-flash` and the supported legacy aliases `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are recognized automatically. Both Chat Completions and Responses support the cropped image. `deepseek-v4-pro` is treated as text only according to the official [vision guide](https://api-docs.deepseek.com/guides/vision/) and [model capability table](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/).

For custom models or gateways, set the model's vision capability in translation service settings to match the actual endpoint. Network, key, and response errors remain visible and never silently switch to OCR. The vision prompt can be edited or restored in area translation settings.

The area service can be selected independently or follow the webpage default. Editing DeepSeek's connection settings does not select it as the default service. If the result card says “Free translation service”, select DeepSeek as the area service to use its vision model.

## Standard or AI text enhancement?

Standard translation translates the recognized text directly and works well for clear, simple layouts.

AI text enhancement uses all recognized text in the area to tidy broken lines and translate. It needs a suitable general-purpose AI model. The model cannot see the screenshot or recover characters that recognition missed, so compare with the original.

The area service follows webpage translation by default, but you can choose it separately. Recognition packs are shared with [image translation](/en/guide/image-translation).

## Availability and data

Area capture currently works in the Chrome / Edge extension. Browser internal pages, restricted videos, and unreadable areas may not be captured. Other browsers and userscripts report their available capabilities.

Local OCR keeps the cropped image on your device and sends only recognized text to the translation service. With model vision, only the cropped selection is uploaded for transcription, followed by text translation through the same service. Image recognition requests are not stored in the translation cache. The result card names the actual recognition method, service, and model. For a translated image with its layout retained, use [image translation](/en/guide/image-translation), which continues to use local OCR for text positioning.

## Testing image recognition

Automatic capability selection uses manual overrides first, then a valid local test result, then verified built-in rules. Unknown models are tested on their first area translation. You can also select **Translation services → Model preferences → Test image recognition** to test the current configuration again.

The test sends a small locally generated PNG containing random characters through the same adapter used for image recognition. It confirms support only when the model reads those characters exactly. HTTP 200 or a successful text connection test alone does not prove image recognition. Testing may incur model usage charges, can be cancelled, and never sends a webpage screenshot or changes a manual capability override.

Results expire after seven days and are tied to the service, model, endpoint, API protocol and a fingerprint of the credential configuration. Only the fingerprint, capability and time are stored locally; images, answers, credentials and error bodies are not saved or included in config exports, history or cloud sync. An explicit rejection of image input records unsupported capability. A mismatched answer leaves capability unknown and uses local OCR. Authentication, quota, network and response errors remain visible errors and do not silently switch to OCR.

## Next steps

- [All guides](/en/docs/)
- [Troubleshooting](/en/guide/faq)
