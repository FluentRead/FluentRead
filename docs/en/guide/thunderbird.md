# Translate email in Thunderbird

FluentRead has a separate Thunderbird package. It reuses the Firefox translation services and settings, but injects its content script only into displayed email messages. It does not automatically inject into ordinary web pages or compose windows.

## Build and install

Run `pnpm build:thunderbird` in the FluentRead source directory. This creates `.output/fluent-read-<version>-thunderbird.xpi`. In Thunderbird 140 or later, open Add-ons and Themes, choose “Install Add-on From File”, and select the XPI. The Thunderbird package has its own add-on ID, so its settings are stored separately from the Firefox package.

## Read email

Open a message and click “Translate / Restore current message” in its toolbar to switch between the original and bilingual view. Use the FluentRead button on the main toolbar to choose languages and a translation service or open the full settings. Messages that were already open when the add-on was installed need to be opened again before the translation controls appear.

Choose a translation service, languages, and display mode in settings before first use. If global automatic translation is enabled, newly opened messages are translated automatically. Translating a message sends its text to the selected translation service according to that service's behavior; choose a suitable service for private mail. Image OCR, area translation, and local speech playback are not available in the Thunderbird package yet.

## Next steps

- [All guides](/en/docs/)
- [Troubleshooting](/en/guide/faq)
