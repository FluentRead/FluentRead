# Translation providers

FluentRead sends text to whichever provider you choose—use the zero-setup **Free translation pool** right away, or assign **cloud APIs**, **AI models**, **combo fallbacks**, or **offline local models** independently per feature.

<GuideVisual kind="provider" en />

<DocDiagram kind="provider-routing" en />

## How to choose {#how-to-choose}

| Your goal | Recommended option | Key needed? |
| --- | --- | --- |
| Start translating immediately | **Free translation services** (auto-balanced free nodes) | No |
| Fast, stable long articles & documents | **DeepL / Microsoft / Google** or **Cloud vendor APIs** | Yes |
| Nuanced prose, papers & AI explanations | **OpenAI / DeepSeek / Claude / Gemini** or **OpenAI-compatible** | Yes |
| Keep text on-device or work offline | **Built-in local models**, **Ollama**, or [Built-in browser translation](/en/guide/chrome-translator) | No |
| Automatic failover across providers | **Combo translation provider** (Round-robin / Random / Smart) | Per member |

::: warning Chat subscriptions ≠ API credits
FluentRead is free and open source, while third-party providers bill independently. Consumer chat plans (such as ChatGPT Plus or Claude Pro) rarely include API quota—check your provider’s developer console for pricing and limits.
:::

## Configure & assign in 4 steps {#configure-and-start}

1. Open **Settings → Translation providers** and select a provider (clicking an item opens its credential form without changing your active default).
2. Enter the required API key, endpoint, or region. For AI services, pick a model (or enter the exact API model ID under **Custom model**; Azure uses your **deployment name**).
3. Click **Check connection** (sends one short test request that may consume minimal quota).
4. Click **Set as default translation provider**, or assign providers per feature in the popup’s **Translation services** menu or **General → Service assignments**.

<figure class="doc-figure"><a href="/screenshots/ui/en-US/settings-services.webp" target="_blank" rel="noopener"><img class="doc-screenshot" src="/screenshots/ui/en-US/settings-services.webp" width="2560" height="1600" alt="FluentRead translation service directory and connection settings" loading="lazy" /></a><figcaption>Configure and verify a provider first, then set it as default or assign it to a feature.</figcaption></figure>

### Removing & restoring providers

Click **×** on a provider row to hide it from the directory (at least one provider must stay active). Restore any hidden provider anytime under **Custom providers → Restore removed providers** with all saved keys, models, and assignments intact.

## Free pool & batching reliability {#how-free-translation-works}

- **Auto-balance vs. priority:** Free translation balances across enabled candidates by availability and speed (falling back on errors), or tries them in strict priority order. Health stats stay local.
- **Experimental nodes & Bilibili:** Doubao web (anonymous, never reads personal cookies or Doubao API keys) and Reverso are experimental; Bilibili batches multi-line blocks and falls back line by line on mismatch.
- **Machine-translation batching:** Google, Microsoft, DeepL, Azure, and Google Cloud enable **Request limits → Merge translation requests** by default to cut request count (character billing stays unchanged) and fall back per segment on malformed responses without caching broken output.

## On-device offline translation {#local-model-translation}

No API key required—translation text never leaves your machine:

### Built-in local models (Browser extension only)

Download and verify models under **Translation providers → Local model translation**:

| Model | Download size | Best for |
| --- | --- | --- |
| **ZH–EN Lightweight** | ~239 MB | Quick everyday Chinese ↔ English sentences |
| **Hunyuan Hy-MT2 1.8B** | ~1.13 GB | Multilingual & nuanced sentences (requires more RAM) |
| **JA–EN Lightweight** | ~214 MB | Japanese → English (EN → JA quality is limited) |

Downloads support pause/resume and mirror fallback, stay in local browser storage (excluded from backups), and release RAM automatically when idle. See [local model FAQ](/en/guide/faq#do-local-models-reload-on-every-request-or-stay-in-memory-forever).

### Ollama, Rapid-MLX & Built-in browser translation

- **Ollama (Local):** Start Ollama and pull a model, then select **Aggregators & endpoints → Ollama (Local)** (`http://127.0.0.1:11434`, no key required). On slower hardware, set service concurrency to `1` under **Request limits**.
- **Rapid-MLX (Apple Silicon):** Install with `pip install rapid-mlx`, then allow the extension origin: `rapid-mlx serve qwen3.5-4b-4bit --cors-origins chrome-extension://djnlaiohfaaifbibleebjggkghlmcpcj` (unpacked builds: use the ID from `chrome://extensions`; Firefox: `moz-extension://<uuid>`). Select **Rapid-MLX → Custom model** and enter an exact model ID from `curl http://127.0.0.1:8000/v1/models`; no key required. For another port, enter the full `/v1/chat/completions` URL in the proxy field.
- **Built-in browser translation:** Desktop Chrome 138+ and Edge 148+ support the native Translator API—see [Built-in browser translation](/en/guide/chrome-translator).

## Classic & cloud vendor APIs {#using-cloud-providers}

| Provider | Required credentials | Notes |
| --- | --- | --- |
| **DeepL** | API Key (Free or Pro) | Web subscriptions cannot be used as API keys |
| **DeepLX** | Optional URL & Token | Empty config tries anonymous DeepL then public DeepLX; custom URLs need the full path (e.g. `https://deeplx.example.com/translate`) and support literal <code v-pre>{{apiKey}}</code> placeholders (<code v-pre>?token={{apiKey}}</code> or <code v-pre>/{{apiKey}}/translate</code>) |
| **MyMemory** | Email (optional) | Specify source language manually if short text misdetects |
| **Google Cloud Translation** | API Key | Enable Cloud Translation API in Google Cloud Console |
| **Azure Translator** | Key, Region | Region must match your Azure resource |
| **Alibaba Cloud MT** | AccessKey ID, Secret, Region | Credentials stay local and out of public shares |
| **Tencent Cloud TMT** | SecretId, SecretKey | Check IAM permissions and system clock on signature errors |
| **Baidu Translate** | APP ID, Key | Expand **Setup guide** in settings for console steps |
| **Volcengine Translate** | Access Key ID, Secret, Region | Region must match your console resource |

## AI models, combo fallback & multi-key rotation {#using-ai-providers}

### AI context & multi-segment translation {#ai-context-and-multi-segment-translation}

Both options are off by default and toggle independently (restore original and re-translate to apply):

- **AI refined translation (Context):** Includes title, section headings, nearby passages, and completed translations for better terminology and pronouns (kept per session).
- **AI multi-segment translation:** Combines adjacent sibling paragraphs (default **8 segments / 2,000 chars**, tunable `2–32` / `500–12,000`, fixed `32 ms` collection window). OpenAI-compatible services with default prompts validate compact JSON IDs, retry missing slots, and fall back to per-segment mode if a batch fails validation.
- **Claude & DeepSeek Responses:** Always await full non-streaming responses and surface truncation, refusal, or incomplete tool calls as failures instead of rendering partial output.

### Combo translation providers {#combo-translation-providers}

Under **Custom providers → Combo translation**, combine at least two configured providers (no nesting) with a per-member timeout (default `12 s`, range `1–45 s`):

- **Round-robin:** Rotates primary provider across requests and falls back on failure.
- **Random:** Shuffles candidate order per request.
- **Smart:** Prefers members with higher recent success rates and lower latency (does not judge translation quality).

::: note Billing & privacy note
Fallback retries send the same source text to backup members and consume their quotas—review each provider’s pricing and privacy policy.
:::

### Multiple API keys {#using-multiple-api-keys}

Enable rotation under **Key management** and add one key per line (shared endpoint, model, and headers). Failed, rate-limited, or exhausted keys cool down automatically; **Check connection** tests each unique key cleanly.

<details class="guide-details">
<summary>Custom compatible endpoints, headers, proxies & ACP bridge (Advanced)</summary>

### Custom provider Base URL

**Custom providers → Compatible API** uses OpenAI Chat Completions:

| Entered URL | Actual request target |
| --- | --- |
| `https://api.example.com` | Appends `/v1/chat/completions` |
| `https://api.example.com/v1` | Appends `/chat/completions` |
| Full endpoint / proxy URL | Used verbatim (keeps query parameters) |

For example, [OpenCode Zen](https://opencode.ai/docs/zen/) uses `https://opencode.ai/zen/v1` with the bare API model ID (without `opencode/` prefix; see [Go docs](https://opencode.ai/docs/go/)). Endpoints requiring `/responses`, `/messages`, or native Gemini protocols cannot use this generic adapter.

### Custom headers & stripping Origin / Referer

- **Custom headers:** Enter a flat string JSON object (e.g. `{"X-Title": "My client"}`) under **API compatibility → Custom headers** (stored as credentials). Disable API key requirement if using custom auth headers.
- **Strip Origin / Referer:** If a self-hosted API rejects extension origins, add its exact hostname (no scheme/port/wildcard) under **API compatibility → Strip origin headers**.

### Gemini proxy & Tencent Hunyuan TokenHub

- **Gemini proxy URL:** Supports full template `https://myproxy.example/v1beta/models/{model}:generateContent?key={key}` (only use trusted proxies).
- **Tencent Hunyuan:** **Hunyuan LLM** moved to Tencent Cloud [TokenHub](https://console.cloud.tencent.com/tokenhub/) with region-specific keys (Global `tokenhub-intl.tencentmaas.com` vs. Guangzhou `tokenhub.tencentmaas.com`); **Hunyuan MT** still uses SecretId/SecretKey ([official docs](https://cloud.tencent.com/document/product/1823/132252)).

### Local Agent ACP bridge (Experimental)

Run the local [ACP bridge](https://github.com/FluentRead/FluentRead/blob/main/scripts/agent-bridge/bridge.mjs) for authenticated GitHub Copilot CLI or OpenCode:

```sh
node scripts/agent-bridge/bridge.mjs --agent=copilot
```

Use `--agent=opencode` for OpenCode, then enter the printed loopback URL and session token in a Compatible API provider (never share tokens). Supports non-streaming text only, with all agent tools disabled.

</details>

## ChatGPT plan status & connection troubleshooting

- **ChatGPT plan:** Not yet open in public builds—see [ChatGPT plan availability](/en/config/chatgpt-plan).
- **Connection errors:** Verify endpoint path/protocol (an HTML 404 usually means wrong URL, not invalid key), API balance, region, and lower concurrency under [Request limits](/en/config/#request-limits) if long pages fail while short tests pass. Never share real keys in bug reports.
