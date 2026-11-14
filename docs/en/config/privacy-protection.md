# Translation privacy

Open **Advanced options → Translation privacy**. Protection is off by default. When enabled, new text translation requests are checked locally before they reach a provider. No model download or proxy installation is required.

## Actions

- **Mask before translation, restore locally** replaces detected values with random request-specific placeholders. Repeated values share a placeholder. Responses are checked per text segment before local restoration; missing, duplicated, damaged or misplaced placeholders cause an error. The original text is never sent as a fallback.
- **Block when sensitive content is found** stops a request when its text, context or custom prompts match a rule.

Choose email, phone, identity-number, payment-card/IBAN, password/secret and IPv4 detection separately. IPv4 detection is off by default. Selected formats use checksums to reduce false positives. Ordinary years, dates and unlabelled short numbers are not automatically treated as verification codes.

## Custom phrases and preview

Choose **Manage** next to **Custom sensitive text**, add one exact, case-sensitive name, address or internal phrase per line, then save. The limit is 128 phrases of 256 characters each; regular expressions are not accepted. Phrases use local credential storage, are not broadcast to webpages, and are excluded from settings history and ordinary backups. Explicit sensitive-configuration exports can include them.

The compact **Masking preview** shows how the selected rules handle a fixed example. It updates automatically and has no test-input field or network request. The example does not prove complete detection of other text.

## Scope

Protection covers text sent through the shared translation pipeline: pages, hover/selection, input fields, documents, subtitles and locally recognized image text. It includes page summaries, discourse/subtitle context, custom prompts and request bodies, and remains active during retries and provider fallback. Provider authentication credentials and headers are still used for authentication.

This is not a browser-wide firewall. Reading-assistant, AI-writing, audio-recognition and cloud-OCR requests are outside this switch. Original images cannot be sanitized as text, so image uploads through the translation interface are blocked while it is enabled. Use local OCR followed by text translation instead.

Rules cannot recognize every name, address, language or encoded/rephrased secret. Add custom phrases where needed. Remaining context can still reveal identity; use local translation or avoid sending material that must not reach a provider.

New protected requests skip persistent translation-cache reads and writes. Existing cache entries, recent documents, learning records and exported files retain their own storage rules and can be cleared separately. The switch does not delete them. Restoration mappings remain in request memory and are released afterwards; they are not logged or backed up.

The implementation independently adapts ideas from [OneAIFW](https://github.com/funstory-ai/aifw), [Microsoft Presidio](https://github.com/microsoft/presidio) and [Gitleaks](https://github.com/gitleaks/gitleaks). None becomes a runtime dependency. Rule-based and model-based detection have different coverage; no unmeasured speed or accuracy ranking is claimed.
