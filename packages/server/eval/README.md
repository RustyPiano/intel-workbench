# RAG Eval Harness

This harness benchmarks retrieval quality on a synthetic, labeled corpus. It is a dev tool and is not part of `npm run check` execution beyond TypeScript compilation.

## Run

```bash
source dev.env.sh
npm run eval:gen
# spot-check packages/server/eval/corpus/docs/*.txt and corpus/queries.jsonl
npm run eval -- --variant=baseline
```

`eval:gen` uses the configured text LLM to regenerate `corpus/` from scratch. `eval` uses the configured embedding slot and optional rerank slot to write `results/<ISO>-baseline.json` and append one row to `results/summary.md`.

## Corpus Format

- `corpus/docs/*.txt`: UTF-8 source documents.
- `corpus/queries.jsonl`: one JSON object per line:

```json
{"qid":"q-001","query":"...","relevant":["doc-001#0"],"note":"auto"}
```

## Gold Labels

The generator creates fictional Chinese intel-domain documents, chunks them with the same deterministic text-doc path used by ingest, then asks the LLM for questions answerable only by sampled chunks. Each generated question is labeled with that chunk id as the relevant gold chunk.

Gold labels are tied to the deterministic chunker: changing `normalize()` or `chunkText()` invalidates existing `relevant` ids and requires regenerating the corpus.
