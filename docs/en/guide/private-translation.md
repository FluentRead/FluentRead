# Private-window translation model

Enable **Settings → General → Private-window translation model**, select a connection, and enter an explicit model ID. The feature is off by default. Disabling it preserves the selection; ordinary windows continue to use their existing feature settings.

The initial supported connections are **OpenAI and configured custom OpenAI-compatible services**. The selected service supplies its endpoint, API key, headers, and quotas. Create a separate custom AI service if you need separate credentials or an endpoint. Ordinary-window service identity is not copied into the private connection, and no model is automatically called to test the configuration.

## Failures do not fall back to the ordinary model

- A deleted service, missing model or credentials, or unavailable model produces an error rather than an ordinary-model fallback.
- Only standard request bodies are supported. A nonempty custom request body is rejected, not silently ignored. Use a separate standard connection.
- Enter the actual model ID without a display suffix. If compatibility rules would rewrite an ID, such as a retired alias at the official MiMo endpoint, use the final model ID instead.
- All recognized private-window translations bypass shared translation and page-summary caches, regardless of this setting. Repeated requests may call the model again. Once configuration is ready and a snapshot is taken, the request, scheduling, and statistics retain that snapshot's service, model, credentials, and trusted privacy identity. Later settings edits cannot reroute it; edits made while waiting for configuration readiness may still affect the eventual snapshot.

## Scope and privacy boundaries

Only browser-supplied sender metadata identifying a private window enables this selection. Self-reported message fields such as `privateContext` or `incognito` do not grant that identity. With the feature enabled, an unknown identity fails explicitly without calling either connection. With it disabled, unknown identities use ordinary routing, which is not a private-window guarantee. The browser must still grant the extension permission to run in private windows.

This covers text flowing through the shared translation broker while preserving trusted identity, including full-page, hover, selected-text, input-box, subtitle, document text, and recognized image or region text. Offline verification covers ordinary item-by-item arrays, page/document AI multi-segment batches, wrong-language single-slot recovery, and document malformed-slot splitting. Each outbound call retains the dedicated connection identity, with no shared-cache reads or writes. Real browser document entry points remain unverified.

**This is not an all-modality privacy switch.** Independent reading explanations, writing, dictionary lookups and auxiliary definitions, voice, OCR, and image recognition are outside this promise. Images before recognition may still use the original configuration. Direct integrations and userscripts lack this trusted browser identity: importing an enabled setting makes shared translation reject unknown sources, so disable the setting to continue there. Internal vision-capability probes also lack tab identity and cannot run with this mode enabled. Dictionary auxiliary translation is rejected and retains the original dictionary text. The implementation does not invent an ordinary identity to bypass these checks.

Private browsing and local cache isolation do not guarantee that a provider retains no data. Review the selected provider's privacy policy and connection settings.

## Verification scope

The `privateTranslation`, `privateTranslationIntegration`, and `privateTranslationSettingsLifecycle` suites use real configuration, background fallback, the broker, the pinned AI SDK, Vue templates, and offline HTTP fixtures. They check outbound model/endpoint/credentials, ordinary array translation, concurrent cache isolation, errors without fallback, cancellation, configuration snapshots, and settings close/reopen and late events.

This does not establish acceptance on real private windows, physical Firefox devices, external model quality, or every multimodal entry point. No user device, user credentials, or external model was accessed for these checks.

Input-box translation resolves the effective trusted-window connection and model before applying the input-specific system and user prompts. Even when the ordinary input service is a machine translator, a private request applies those prompts to its dedicated AI model. Configuration edits after readiness and snapshot creation do not alter that request; requests still waiting for configuration readiness are excluded from that guarantee.

When the dedicated setting is enabled, extension pages defer credential checks to the background broker instead of rejecting a request based on the ordinary connection. The broker checks the effective connection using trusted window identity; an ordinary window with missing credentials is still rejected.
