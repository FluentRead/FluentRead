# Reading appearance

Open **Reading appearance** in the extension popup and choose **System default** to preview the page’s text font without first enabling translation. When the global browser-default translation font is off, original and translated text, including translations added later, use the same system font. Choose **Original website font** to restore it immediately.

Changes apply only to the current page by default and are reset on refresh or navigation to a new page. To keep a choice, click **Save current choice**. Website preferences use the same base-domain scope as existing website rules. Clearing a website preference leaves the current preview intact; new pages use the original font. Ordinary in-page anchors preserve the preview, while hash-based routes such as `#/article/2` and `#!/article/2` count as new pages.

This feature changes fonts only. It does not download fonts or change text content. Different font metrics can change line wrapping or page layout. Code, formulas, icons, form controls and extension UI retain their original styling. Disabling the extension or the current website, or leaving the page, removes font overrides. Website structures vary: canvas and image text, protected regions and some complex layouts are outside its scope. Not all website text can be recognized reliably.

Development checks: `pnpm test tests/readingAppearanceRuntime.test.ts tests/readingAppearanceComposition.test.ts tests/readingAppearanceContent.test.ts tests/popupReadingAppearance.test.ts`. Also run type checks, architecture checks, and Chrome / Firefox builds. DOM tests do not replace visual acceptance testing on real websites and browsers.


The global browser-default translation font takes precedence for translated text (CSS initial). Reading font still applies to source prose. With that global preference off, reading system font also applies to translations. Both modes share the existing translation style roots; reading appearance no longer writes inline translation fonts.
