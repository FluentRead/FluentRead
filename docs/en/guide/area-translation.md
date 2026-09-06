# Draw around the bit you need

Use area translation for words inside screenshots, charts, paused video frames, or comic bubbles. The result is a card with text you can copy.

## Select an area

1. Enable area translation and prepare the matching recognition language pack.
2. Press **Shift + Z** once, then drag around the area.
3. Release the pointer and wait for recognition and translation.
4. Copy the translation, expand the recognized original, or view the captured area.

Press **Esc** to exit. Choose a new selection to capture elsewhere, or retranslate to reuse the current capture with a changed service. Scrolling or resizing requires a new selection.

## Standard or AI text enhancement?

Standard translation translates the recognized text directly and works well for clear, simple layouts.

AI text enhancement uses all recognized text in the area to tidy broken lines and translate. It needs a suitable general-purpose AI model. The model cannot see the screenshot or recover characters that recognition missed, so compare with the original.

The area service follows webpage translation by default, but you can choose it separately. Recognition packs are shared with [image translation](/en/guide/image-translation).

## Availability and data

Area capture currently works in the Chrome / Edge extension. Browser internal pages, restricted videos, and unreadable areas may not be captured. Other browsers and userscripts report their available capabilities.

The capture is cropped and recognized locally. Only recognized text goes to your selected translation service. For a translated image with its layout retained, use [image translation](/en/guide/image-translation).
