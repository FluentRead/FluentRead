# Translation statistics

Open **Settings → Translation statistics** to see how large your translation requests are, how long they take, and how fast and reliable each translation service is.

## Overview

- **Translation requests**: request count and success rate. Errors and timeouts are counted separately; requests cancelled because you left the page are not failures.
- **Text translated**: source characters, segments, and data size sent for translation.
- **Average duration**: time from starting a translation to receiving it, with P95, the longest duration, and how much of it was spent waiting for the service.
- **Cache reuse**: the share of segments served from existing translations without calling a service again.

Filter by service, model, and time range (today, 7 days, 30 days). The trend chart can show requests, average duration, or text volume.

## Compare services

**Service performance** lists requests, success rate, average duration, P95, longest duration, and average size for each service and model. Select a column header to sort, or a row to focus on that service.

Durations include only successful requests that reached a service. Results returned directly from cache take almost no time and would pull the average down, so they are excluded. P95 means about 95% of requests finish within that time; it is estimated from the duration distribution.

Batch requests contain several segments and naturally take longer. The “≈ X characters/s” figure on each row helps compare services fairly.

## Free translation routes

With free translation, one request may try several routes in turn (Microsoft, Google, Youdao, and so on), switching automatically after a failure. The **Free translation routes** table lists attempts, success rate, average duration, P95, longest duration, and average size per route, so you can tell which routes are fast and which fail often, then adjust the enabled routes or their order under **Translation services → Free translation**.

Because failures are retried on other routes, route attempts usually outnumber requests, and route durations count successful attempts only. The request history also shows which routes served each request.

## Distributions and failures

The duration and request size distributions show whether slow requests are rare or common. Failures are grouped into invalid key or permission, rate or quota limit, timeout, network issue, and more. If rate limits are frequent, lower concurrency or requests per second in **Advanced**.

## Request history

Request history lists recent translation requests with time, service and model, size, source, status, and duration. Filter by source or status, or sort by **Slowest** to find the longest requests.

| Source | Meaning |
| --- | --- |
| Service | Text was sent to the translation service |
| Cache hit | Every segment came from the translation cache |
| Partly cached | Some segments of a batch came from cache; the rest were requested |
| Merged | Shared the result of an identical request already in progress |

## Storage and clearing

Statistics stay in this browser. The latest 5,000 requests are kept in request history, and hourly summaries are kept for 90 days, so longer ranges are not limited by the history size. **Clear statistics** deletes all statistics without affecting the translation cache, model usage, or settings.

For AI token usage, see [AI usage](/en/guide/model-usage).
