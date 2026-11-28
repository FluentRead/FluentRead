# Translation privacy shield

Automatically detect and handle emails, phone numbers, IDs, bank cards, API keys, and custom sensitive terms locally in your browser before text is sent to any translation provider—no model downloads or proxies required.

Enable under **Advanced settings → Translation privacy shield** (off by default).

<DocDiagram kind="privacy-shield" en />

## Two protection modes

| Mode | How it works | Safety guarantee |
| --- | --- | --- |
| **Redact locally, restore after translation** | Replaces matched values with per-request random tokens before sending, then restores originals locally on return | Validates every token in batch responses; if any token is missing, duplicated, altered, or misplaced, display is aborted and **plaintext is never resent** |
| **Block request when detected** | Stops the request whenever body text, context, or custom prompts match an enabled rule | Zero bytes leave your browser—ideal for strict zero-leak workflows |

## Built-in categories & custom terms

- **Built-in rules:** Email addresses, phone numbers, ID numbers, bank cards & IBANs, passwords & API keys, and IPv4 addresses (IPv4 is off by default). Cards and select IDs use format/checksum validation so ordinary dates or short numbers are not falsely flagged.
- **Custom sensitive terms:** Click **Manage** to enter one exact case-sensitive name, internal code, or address per line (up to **128 entries**, **256 characters** each, plain text rather than regex). Stored in local credential storage and excluded from settings history and basic cloud backups.
- **Local preview:** The built-in preview updates live with sample text to show the `***` redacted format for active rules and sends zero network requests.
- **Collapsible redaction & block log:** Collapsed by default at the bottom of the card, displaying summary counts (masked, blocked, protected items) right on the header. Expand to filter by action or category and inspect irreversible `***` summaries (such as `d***@e***.test`, `138****00`, `sk-***`) confirming protection actually triggered. Stored locally only with zero raw text or full secrets, never recorded in private windows, and clearable anytime.

## Scope & limitations

- **Covered:** Unified text translation across webpages, hover, selection, input boxes, documents, captions, and OCR-extracted image text (including summaries, context, custom prompts, and request bodies, across retries and batching).
- **Not covered:** This is a text-translation safeguard, **not a browser-wide firewall**. Separate flows such as AI reading explanations, writing assistant, audio ASR, and cloud vision OCR are outside this switch; raw image uploads through the unified interface are blocked while enabled (use local OCR instead).
- **Cache & memory:** Persistent translation cache reads and writes are skipped while enabled; placeholder mappings live strictly in transient memory and are discarded after each request.
- **Rule limits:** Pattern matching cannot catch every language or paraphrased identifier—add custom terms where needed, or use [on-device local models](/en/config/translation-engines#local-model-translation) for highly confidential material.

## Design references

Independently implemented in FluentRead’s TypeScript architecture, inspired by local redaction/restoration concepts in [OneAIFW](https://github.com/funstory-ai/aifw), validation ideas in [Microsoft Presidio](https://github.com/microsoft/presidio), and fast matching patterns in [Gitleaks](https://github.com/gitleaks/gitleaks), with zero runtime dependencies on those repositories.

## Related guides

- [Privacy policy](/en/guide/privacy)
- [Translation providers & local models](/en/config/translation-engines)
