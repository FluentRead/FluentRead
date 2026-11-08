---
outline: false
---

# Choose your translation service

FluentRead sends text to the service you choose. Start with free translation, or connect an existing machine-translation account, AI provider, or local model.

<GuideVisual kind="provider" en />

## Which one fits?

| What you need | Choose |
| --- | --- |
| Start without a key | Free translation service |
| Use an existing translation account | Its DeepL, Microsoft, Google, or other service |
| Use an official cloud API | Google Cloud, Azure, Alibaba Cloud, Tencent Cloud, Baidu, or Volcengine |
| Translate complex expressions or use AI explanations | An AI service with a working key and model |
| Process translation text locally | Local model translation, Ollama, or [Chrome local translation](/en/guide/chrome-translator) |
| Rotate services or retry with another provider | Combined translation |

FluentRead is free and open source. Providers may charge separately. Chat subscriptions may not include API allowance; check free quotas, regional availability, and overage rules with your provider.

## Connect and use it

1. Open **Settings → Translation services**, then search for or select a service.
2. Enter the provider’s key and URL when required. AI services also need a model.
3. Choose **Check connection**. It sends a short request and may use allowance; success describes that check only.
4. Choose **Set as default translation service**, then try a webpage. Documents, subtitles, and the reading card can have separate selections.

Selecting a directory entry opens its connection settings and leaves the default service selected. You can assign services from **Translation service** in the extension menu or **Services by feature** in General settings. **Services by feature** starts expanded. Select its heading to collapse it.

<figure class="doc-figure"><a href="/screenshots/ui/en-US/settings-services.webp" target="_blank" rel="noopener"><img class="doc-screenshot" src="/screenshots/ui/en-US/settings-services.webp" width="2560" height="1600" alt="FluentRead translation service directory and connection settings" loading="lazy" /></a><figcaption>Configure and check the connection, then choose the default or assign it to a feature.</figcaption></figure>

## Remove and add back services

In **Settings → Translation services**, select the **×** beside a service and confirm to remove it from the directory and stop new requests to it. If you remove the default, the confirmation names the service that will take over. Keep at least one available service in the directory.

To restore a service, open **Custom service** and choose **Restore removed services**. Search for and select the service, then click **Add service**. Your saved keys, models, and feature assignments are preserved. While the service is removed, other pickers mark it as unavailable or hide it. Combined and free translation skip it while keeping their saved member settings.

## The free service

**Automatic balance** distributes requests among enabled services based on availability and speed. Failure may send the same text to another provider. **Priority order** tries the list in order; keep at least one enabled. To use one provider only, disable the others or select its standalone service.

Choose candidates under the participating-services section. Free web endpoints can change, throttle requests, or stop working. Paused candidates are tried again later; health records stay local. Doubao Web and Reverso are experimental. Check language support for each service, including Traditional Chinese targets and Apertium’s Chinese pairs.

Doubao Web uses anonymous guest parameters and does not read personal cookies or the API key configured for the separate Doubao service. Anonymous access does not guarantee continued free use. Each candidate has its own data policy.

## Google translation speed and fallback

Google translation needs no key. Page translation automatically groups short passages to reduce requests and tries another available endpoint after failure. Rate limits cause a wait before retrying; these measures do not increase the provider’s quota.

Free Google translation, Google Cloud Translation, Chrome’s built-in page translation, and Chrome local translation are separate services.

## Multi-text requests and reliability

Google, Microsoft, DeepL, Azure, and Google Cloud enable **Request limits → Combine translation requests** by default. Page translation groups short passages with matching settings and keeps each result paired with its source. Disable it for individual requests. The free service follows this setting when using Google or Microsoft.

This differs from **AI multi-paragraph translation**, which is off by default. Grouping reduces request count, not character-based charges. Missing or broken results trigger individual recovery; failed recovery keeps the original and shows a failure instead of caching invalid output.

## Claude and DeepSeek Responses translation

For translation through these interfaces, FluentRead waits for a complete nonstreaming response. Translation requests remain nonstreaming even if the custom request body sets `stream: true`. Explicit truncation, refusal, or unfinished tool calls produce an error instead of being presented as a complete translation.

DeepSeek Responses can return a completed server-side search alongside the final translation; search availability depends on the selected model and service. Translation does not execute client-side tool calls.

## Combined translation services

1. Choose **Custom service → Combined translation** and enter a name.
2. Add at least two existing services and arrange their order. Combinations cannot contain other combinations.
3. Select a strategy and timeout, save, then check the connection.
4. Set it as the default or assign it to a feature like any other service.

| Strategy | Behavior |
| --- | --- |
| Round robin | Rotate the first choice through the list; try other members after failure |
| Random | Shuffle the order for each request and try remaining members after failure |
| Smart | Prefer recently successful, faster members and fall back after failure |

Each request returns the first successful result, without combining several translations. Smart routing does not assess translation quality. Members keep their own models, keys, prompts, and limits, so configure them first.

Each member has a default timeout of 12 seconds, adjustable from 1–45 seconds, within the overall request deadline. Cancellation stops fallback. Trying several providers can send the same source and consume allowance at each; consider their data policies and charges. Deleting a combination keeps member services. Imported combinations with no members need repair before use.

## Use several API keys

Enable rotation in **Key management**, then add one key per row. Keys share the service URL, model, region, and headers. Create separate services when those settings differ.

Requests are distributed across keys. Failures try another key; invalid, rate-limited, or exhausted keys are paused or used less often. Rotation does not bypass service limits or the overall timeout.

**Check connection** tests distinct nonempty keys in order. Row controls can retest one key, and you can stop remaining checks. Empty and duplicate entries make no extra requests. Checks may use a small allowance.

## MyMemory

The contact email is optional. Check the connection directly. Regular translation uses your chosen languages; if detection cannot identify a short source, select its language manually.

## DeepL

Choose **DeepL API Free** or **API Pro** and enter the matching key. Website subscriptions and API plans are separate products.

## DeepLX

With an empty key and an empty or default service URL, FluentRead first tries DeepL’s anonymous endpoint, then the default public DeepLX endpoint. A custom URL, proxy, or key keeps requests on the specified route; proxy takes priority.

Use the complete custom path, such as `https://deeplx.example.com/translate`. A domain alone does not add `/translate`. Keyless endpoints can leave the key empty. For token authentication, enter the token without `Bearer`; it is sent in a header by default. If the provider requires URL authentication, use its supported placeholder form:

- Query: <code v-pre>https://deeplx.example.com/translate?token={{apiKey}}</code>
- Path: <code v-pre>https://deeplx.example.com/{{apiKey}}/translate</code>

Keep the placeholder unchanged rather than writing a real token in the URL. A missing required key does not fall back to a public endpoint.

## Cloud vendors

Enable the official API and create credentials in the provider’s console. Select the service and open its setup guide for console and API links.

| Service | Fields |
| --- | --- |
| Google Cloud Translation | API key |
| Azure Translator | Key and region |
| Alibaba Cloud Translation | AccessKey ID, AccessKey Secret, and region |
| Tencent Cloud Translation | SecretId and SecretKey |
| Baidu Translate | APP ID and key |
| Volcengine Translate | Access Key ID, Secret Access Key, and region |

Use the resource’s actual region. For authentication failures, check matching and active keys, translation permissions, service activation, and account status. Timestamp signature errors also require checking the device clock. Report the provider’s error code without sharing keys or complete requests.

Credentials stay local and are excluded from public configuration sharing and settings history. Full backups and cloud backups with explicit sensitive-settings consent can include them.

## Local model translation

Under **Translation services → Local model translation**, choose and download a model. Once it is ready for offline use, try a sentence and select it as your service. It requires no key or separate server; translation text is processed on the device.

| Model | Approximate download | Use |
| --- | --- | --- |
| Lightweight Chinese–English pack | 239 MB | Simple Chinese–English sentences |
| Hunyuan Hy-MT2 1.8B | 1.13 GB | More languages and complex expressions, with higher memory needs |
| Lightweight Japanese–English pack | 214 MB | Japanese-to-English; limited English-to-Japanese quality |

Pause, resume, or retry downloads; leaving settings does not stop background downloading. Files must finish verification before use. If a source fails, another source supplies the same fixed, verified version.

Models stay in this browser and are excluded from configuration backups. Deletion requires confirmation and affects only the chosen model. Download size is not runtime memory use: loading can noticeably increase CPU, RAM, or GPU use, and idle resources are released. See the [local-model FAQ](/en/guide/faq#do-local-models-reload-on-every-request-or-stay-in-memory-forever).

This feature requires the browser extension and is unavailable in the userscript. Model information links show sources and licenses. If a model is incompatible with the browser, choose another model or service.

## AI services

Enter the service key, select a model available to your account, and check the connection. Use a custom model when needed, copying its API model ID from the provider. Azure uses your deployment name.

Default models suit everyday translation; larger models remain optional. For discontinued-model errors, check the provider’s current list. Review models and custom request parameters after restoring older backups too. Prices and allowance depend on the provider.

### Extra AI context and multi-paragraph translation

Both options are off by default and can be enabled separately:

- **Extra AI context** sends the title, description, parts of the article, chapter definitions, and completed translations as reference. It may improve consistency but increases submitted context, allowance, and waiting time. References remain in the current session, may miss distant content, and do not guarantee correctness.
- **AI multi-paragraph translation** sends directly adjacent passages under the same parent together to reduce requests. It requires an AI service that supports general prompts; combined services are not supported. Hover translation still sends its current paragraph only.

Once enabled, **Batch limits** default to at most **8 text fragments and 2,000 source characters**, adjustable to **2–32** and **500–12,000** respectively. A batch splits when either limit is reached; a single long paragraph stays intact without truncation. A rich-text paragraph can contain several fragments, so fragments do not equal webpage paragraphs. The collection window is fixed at **32 ms**: later fragments do not extend it, and batches are not guaranteed to fill.

Turning the option off preserves the limits; **Reset** restores only those two values. Larger batches are not always faster and depend more on the model returning every translation. Missing or duplicate markers and incomplete results make the entire batch fall back to individual requests; later passages with the same request settings also use individual requests for the current page session.

Restore the original page and restart full-page translation after changes. Use a [glossary](/en/guide/glossary) for required terms.

### Custom-service Base URLs

**Custom service → Compatible endpoint** uses OpenAI Chat Completions:

| URL form | Request destination |
| --- | --- |
| `https://api.example.com` | Adds `/v1/chat/completions` |
| `https://api.example.com/v1` | Adds `/chat/completions` |
| Complete endpoint path | Uses the entered URL |

Other nonstandard paths are treated as complete endpoints. A proxy takes priority and requires its full path, without automatic completion. Query parameters are retained. Models offering only `/responses`, `/messages`, or native Gemini protocols cannot use this compatible endpoint directly.

For example, [OpenCode Zen](https://opencode.ai/docs/zen/) uses `https://opencode.ai/zen/v1`. Check that the model supports Chat Completions, and enter its API ID without the client’s `opencode/` prefix. Go’s restrictions are in its [official guide](https://opencode.ai/docs/go/).

## Custom request headers

Open **API compatibility → Custom request headers** and enter the provider’s JSON:

```json
{"X-Title": "My translation client"}
```

Names and values must be strings; matching names replace defaults. You can save a stable session identifier here. If custom authentication replaces a Bearer token, disable the model’s API key requirement when appropriate.

Headers apply only to that custom service and are stored as credentials. Public sharing and settings history exclude them; full backups retain them. Enter them again after changing endpoint or proxy. Browser-restricted headers cannot be overridden through this field.

### Remove Origin / Referer by domain

For a self-hosted API rejecting extension origins, add its actual domain under **API compatibility → Remove origin headers**. Use the proxy domain when applicable.

Enter an exact domain without protocol, port, path, or wildcard. Subdomains do not match automatically. Origin removal is selected by default; Referer is optional. The shared list affects only extension requests. Remove a rule to restore defaults. Userscripts and browsers without the required API do not offer this control.

### Gemini proxy URLs

Enter the full endpoint, optionally using this template:

```text
https://myproxy.example/v1beta/models/{model}:generateContent?key={key}
```

Placeholders use the current model and saved key. A URL containing `{key}` receives that key; importing or changing the proxy retains the saved key, so use a trusted proxy. Without the placeholder, no key is appended automatically. An empty proxy uses the official endpoint.

### Tencent Hunyuan connection failures

**Tencent Hunyuan** uses a Hunyuan console API key. **Hunyuan Translation** instead needs SecretId and SecretKey. A custom gateway needs its matching full endpoint and credentials; see the [official integration guide](https://cloud.tencent.com/document/product/1729/116755).

### Local ACP agent bridge

This experimental feature requires running a local program. Install and sign in to GitHub Copilot CLI or OpenCode first, then run the [bridge](https://github.com/FluentRead/FluentRead/blob/main/scripts/agent-bridge/bridge.mjs) from the source checkout:

```sh
node scripts/agent-bridge/bridge.mjs --agent=copilot
```

Use `--agent=opencode` for OpenCode. Keep the terminal open. Configure the displayed loopback URL and token as a compatible service, using model `default` or an Agent model ID. Update the token if restarting changes it. Press Ctrl+C to stop.

The bridge accepts text-only, nonstreaming requests and disables Agent tools, files, terminal actions, and permission requests. Text still reaches the Agent’s model provider, may consume subscription allowance, and may leave local session records. Other local processes with the token can call it. Keep the token private. Real-account CLI compatibility needs your own verification; a working API can be used directly without the bridge.

## Local models

Ollama needs installation, a running server, and a downloaded model. Select **Ollama (local)**, enter the downloaded model name, and use the default `http://127.0.0.1:11434` without a key. Other devices or ports need a full `/v1/chat/completions` URL. Allow the extension’s origin in Ollama’s server settings.

For slower computers, set the service’s **Request limits → Entire service → Custom** concurrency to **1**. Only that service’s translation requests are local; dictionaries and read-aloud may still use the network. See the [privacy policy](/en/guide/privacy).

## ChatGPT plan availability

ChatGPT sign-in is unavailable in current public releases. Choose an available service; see [integration status](/en/config/chatgpt-plan).

## Connection failed?

Check the URL, key, model, region, and account allowance. If short text works but an article fails, reduce concurrency or the task size. An HTTP 404 returning a webpage usually calls for checking endpoint paths and protocols; it alone does not establish an invalid key.

Echoed source or wrong-language results trigger retry or fallback. Repeated failure keeps the original and shows an error. See [Troubleshooting](/en/guide/faq), and report error codes or redacted screenshots without keys.
