# Choose your translation service

FluentRead puts translation back into reading. Your chosen service produces the words. Start with the default and change it when you need to.

## Which one fits?

| What you want | A starting point |
| --- | --- |
| Start immediately | Free translation service, without an API key |
| Use an existing provider | The corresponding Microsoft, Google, DeepL, or other service |
| Explain sentences, tone, or expressions | An AI service with a working model and credentials |
| Translate text locally | A running Ollama model or available [Chrome local translation](/en/guide/chrome-translator) |

FluentRead is free and open source. Third-party services may charge separately. A web chat subscription does not necessarily include API access.

## Connect and use it

1. Open translation services in settings and select the service to configure.
2. Enter its required key and address; select a model for AI services. Use details supplied by the provider.
3. Check the connection. This sends a short request and may use a small amount of your allowance.
4. Return to the extension menu, select the service, and try a sentence.

::: tip Configuring is not selecting the default
Clicking a service in the directory opens its configuration. It does not change the webpage default. Choose it from the extension menu after setup. Documents, subtitles, and the reading card have their own selections.
:::

<figure class="doc-figure"><a href="/screenshots/en/settings-services.webp" target="_blank" rel="noopener"><img class="doc-screenshot" src="/screenshots/en/settings-services.webp" width="2560" height="1600" alt="Translation service directory and connection settings" loading="lazy" /></a><figcaption>Configure a connection, then select the service you want to use.</figcaption></figure>

## The free service

The default fallback order is Microsoft, DeepLX, Google, then MyMemory. If one fails, the next may be tried, so translation styles can vary. Change the order or disable entries in settings, keeping at least one.

Free services have changing availability and allowances. Public interfaces and intermediaries have their own data policies. Keep only one entry, or select a standalone service, if you want requests to go to only that provider.

## DeepL

Choose API Free or API Pro and enter the matching key. A DeepL website subscription and a DeepL API plan are different products.

## AI services

Select a configured service and model. Use the custom-model option if yours is not listed. For a compatible third-party endpoint, add the address and model under your custom services.

For Azure, enter the actual deployment name as the model and your resource or complete API address as the endpoint.

Extra AI context can reference the page title and parts of the article to help with meaning. It sends more text and can increase usage and waiting time. Multi-paragraph translation groups nearby passages and may reduce request counts, but failures can still require retries. Both options are off by default and can be enabled independently.

Restore existing translations before translating with changed settings. Use [glossaries](/en/guide/glossary) for consistent terminology.

## Local models

Install and run Ollama and download a model before connecting it. Performance depends on the model and computer.

Choosing a local model determines where that translation goes. Dictionary, read-aloud, downloads, and other independent tools can still use network services. See [Data & privacy](/en/guide/privacy).

## Connection failed?

Check the key, address, model, and provider balance. If short sentences work but long pages do not, reduce concurrency or try another service. Never include real credentials in feedback. See [Troubleshooting](/en/guide/faq).
