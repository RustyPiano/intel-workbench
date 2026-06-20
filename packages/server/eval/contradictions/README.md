# Contradiction C1b Corpus

This fixture is a small, controlled contradiction benchmark for Chinese intelligence-analysis text. `corpus.json` has:

- `chunks`: source snippets with `chunk_id`, `material_id`, and self-contained Chinese `text`
- `gold`: unordered `[chunk_id_a, chunk_id_b]` pairs that express a genuine contradiction

The six fictional source documents are represented by material ids `doc-alpha` through `doc-foxtrot`. The corpus plants conflicts over the same entity and attribute: vessel and vehicle counts, arrival dates, sensor locations, hull numbers, deployment status, operating status, departure times, and duty-officer code names. It also includes consistent duplicate facts and unrelated operational notes so precision is measurable.

Gold pairs were constructed manually. A pair is included only when both chunks refer to the same entity and attribute and assert incompatible values. Agreement pairs and merely related operational facts are excluded.

Run the benchmark from the repository root:

```sh
npm run eval:contradiction
```

The runner uses the configured text LLM endpoint and writes results to `packages/server/eval/contradictions/results/<stamp>.json`. Use `--stamp=<name>` to choose a deterministic output filename.
