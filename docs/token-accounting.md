# Token accounting in the ChatGPT Web bridge

## Staff Agent Note (R1×M)

- Problem: `/healthz.prompt_cache` named a local contract-assembly LRU as though it measured provider token-cache hits; canonical context estimates can also differ from the retained browser suffix.
- Change: expose `contract_assembly_cache`, preserve canonical Responses usage, and log privacy-safe metrics for each *accepted physical browser message*.
- Acceptance: no fabricated `cached_tokens`, no reserved/acknowledgement tokens in physical payload metrics, no duplicate acceptance record, and no additional compaction or rejection based on these diagnostics.
- Rollback: revert the health-field rename and accepted-payload observation without changing prompt construction, retained-session ownership, or Responses usage semantics.

## Meaning of each number

`/healthz.contract_assembly_cache` reports local CPU work saved by reusing static contract strings. Its `hits` and `misses` do **not** measure ChatGPT token-cache reads. The former `prompt_cache` field was removed to avoid that ambiguity.

Responses `usage.input_tokens` is an **estimated canonical context** size. It includes the bridge's context reserve and may include older history that was not physically re-sent when a retained browser conversation received only a suffix. `usage.input_tokens_details.cached_tokens` is omitted unless a provider supplies an actual cache-read observation; the browser bridge cannot make that observation. Unknown is not zero. Cached tokens, if ever observed, remain part of total input rather than extra headroom for preflight.

After semantic Send acceptance, the browser worker logs `accepted_payload={...}` with stage number/count, visible text characters/UTF-8 bytes/estimated tokens, skill-file and image counts/estimates, `retainedConversation`, `compaction`, and `cacheReadTokens:null`. Multipart stages are recorded individually; files and images belong only to the final commit. These are transport estimates, not provider billing or proof of a cache hit. The log never includes prompt text, attachment content, or image data. An unaccepted prompt has no accepted-payload record.

The inline compiler keeps the static transport contract before the changing context JSON. That is a stable prefix, but the bridge cannot configure or verify provider-side prompt caching through the ChatGPT browser. OpenAI's [API prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) describes API behavior; it is not evidence of equivalent browser telemetry or discounts.

## Canary comparison

Compare matched, complete tasks in baseline and candidate builds. Sum accepted-payload stages per task, and report retained versus fresh turns, compaction count, checkpoint validation outcomes, context-limit rejections, total task duration, and preflight/Send p50 and p95. A smaller canonical estimate after compaction is not automatically a win: reject any variant that loses an open requirement, creates duplicate accepted stages, shortens previously viable sessions, or increases total task time/rejections. If trace-to-task identity or checkpoint evidence is missing, mark the comparison incomplete; do not infer a cache hit from an LRU hit or from a shorter browser payload.
