# Appearance and reading aids

Make translations easier to distinguish from the original with colors, font size, and styles. Sentence highlighting helps you find the matching sentence.

<GuideVisual kind="appearance" en />

## Adjust the translation style

1. Open **Settings → Interface style → Translation style**.
2. Choose a style card and compare it on **Light page** and **Dark page** previews.
3. Expand **Customize appearance** to adjust colors, font size, and font.

Color and size adjustments update translations on open pages immediately. A different base style applies from the next translation. Bilingual translation styles do not apply in translation-only mode; switch to bilingual display first.

If the webpage font is hard to read, select **Aa** at the bottom right of the quick panel’s translation card to use the browser default font. Select it again to restore the previous font settings. This choice saves automatically and applies to existing and future translations across all webpages, including translation-only mode. It keeps your original style and font size settings.

## Translation style

Styles are grouped into **Text, Colors, Lines, Highlights, Cards, and Fun**. Start with plain text or a color, then try a card, sticky note, or speech bubble to emphasize translations. **Blur until hover** and blackout styles hide the translation until you point at it, useful for checking your understanding after reading the original.

Cards and most Fun styles pair their background, text, and link colors with the text brightness in each part of the webpage. Different sections adapt separately, and existing translations follow website theme changes independently of the extension or system theme. **Terminal** and **Starlit reading** keep their dark themes. Browsers without automatic color support keep each style’s fixed palette.

| Control | Effect |
| --- | --- |
| Text and background color | Give translations their own colors; Default uses the selected style’s colors |
| Line color | Recolor underlines, wavy lines, borders, and quote bars |
| Highlight color | Recolor markers, study highlights, and card backgrounds |
| Font size, weight, font, and opacity | Change size and emphasis; font size ranges from 50% to 250% of the original |

Use swatches, the color picker, or a CSS color value. Invalid values are not saved. Choosing a color card clears text-color and CSS overrides that conflict with its palette while keeping other font and size adjustments. **Reset** returns to the current style’s own appearance. Your chosen text, background, line, and highlight colors take priority over automatic colors. Check readability in both light and dark previews.

If you know CSS, enter declarations under **Enter CSS directly**:

```css
color: rebeccapurple;
background: rgb(255, 248, 204);
font-size: 117%;
```

Leave out selectors. Valid declarations override matching controls; only appearance properties such as colors, fonts, and borders are allowed. URLs, selectors, and positioning properties are ignored. Save a named style to apply it again from its card.

Focusing a translation link with the keyboard also reveals blur and blackout styles. Touch devices without hover show the translation directly. Forced-colors mode uses system text, background, and link colors. Printing removes decorative backgrounds and masks to keep translations readable.

## Bilingual sentence highlighting

1. Enable **Bilingual sentence highlighting** under **Settings → Translation settings → Reading assistance**.
2. Hover over a sentence in the original or translation to highlight both counterparts.
3. Use the style shortcut, or open **Interface style → Sentence highlight style**, to adjust the background and lines.

The highlighter treats source line breaks that the browser collapses as spaces and uses visible line breaks to find sentence boundaries.

Choose from eight presets or customize background and underline colors, opacity, line style, and thickness. Set background opacity to 0% for lines only, or choose **No underline** for background only. Changes save automatically and apply to open pages immediately. **Reset to preset** clears overrides.

Enter a name and choose **Save as new style** to keep up to 12 profiles. **Update selected style** replaces the selected profile; **Save as new style** keeps a separate copy. **Delete selected style** removes the saved profile and keeps the current appearance available for editing. The highlight switch is saved separately.

You can also enter highlight CSS:

```css
background-color: rgba(255, 220, 100, 0.3);
text-decoration: underline wavy #9d4edd;
text-decoration-thickness: 2px;
```

Only [browser highlight paint properties](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Selectors/::highlight#allowable_properties) are supported. Unsupported declarations are flagged and ignored.

Highlighting works only in bilingual mode and sends no additional translation requests. Matching uses sentence order and relative length; it cannot check accuracy and may misalign heavily rewritten text. Restoring the original, disabling highlighting, leaving the text, or selecting text clears it. Browsers without the CSS Custom Highlight API keep normal translation.

## Related guides

- [Smart Highlighting](/en/guide/information-highlight)
- [Settings overview](/en/config/)
- [Page translation](/en/guide/webpage-translation)
