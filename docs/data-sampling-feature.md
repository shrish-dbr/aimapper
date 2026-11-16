# Data Sampling feature (source-data value sampling)

**Status:** experimental, opt-in. Added 2026-09-15.

## What it does

A **per-run toggle** on the Mapper page ("Sample Source Data") plus a **sample-size
slider**. When on, SQL generation reads a small, cheap `LIMIT` sample of each
**used** source table and distills a few **actual distinct values (+ null/empty
rate) per column** into a compact block injected into the generation prompt. This
helps the LLM infer real formats/encodings (date patterns, codes, casing,
identifier/currency formatting) instead of guessing from column types alone.

The **sample size** = how many example values are shown **per source column**
(default 3, range 1–100). This is the parameter that drives token usage (rows
scanned are distilled down to this many distinct values), so the UI shows a live
"≈ +N tokens/generate" estimate that updates as the slider moves. The rendered block
is still capped by `SAMPLE_CHAR_BUDGET` (~10k tokens) to bound very high settings.
The slider lives on the Mapper's "Select Source &amp; Target" step, just above the
Identify/Map button.

- **Default:** OFF. Enabled per-run by the user.
- **Scope:** SQL generation only (`/generate-join-sql`). Attribute discovery is
  unchanged.
- **Privacy:** sends real source values (incl. PHI) to the LLM serving endpoint.
  No column masking is applied (deliberate for now). Samples are **never
  persisted** — they exist only in the transient prompt. Sampling runs via OBO, so
  UC permissions (and any UC column masks/row filters) apply to the sampled data.
- **Cost:** adds ~a few hundred–1.5k input tokens per generate (bounded by
  `SAMPLE_CHAR_BUDGET`), plus one cheap `SELECT … LIMIT` per used source table.

## Tunables

Server (`server/aimapper/dataSampling.ts`): `MIN_SAMPLE_ROWS`,
`DEFAULT_SAMPLE_VALUES`, `MIN_SAMPLE_VALUES`, `MAX_SAMPLE_VALUES`,
`MAX_VALUE_CHARS`, `SAMPLE_CHAR_BUDGET`, the `COMPLEX_TYPE` skip-list, and
`clampSampleValues`. Client mirrors the range constants + `estimateSampleTokens`
in `client/src/pages/aimapper/MapperPage.tsx`.

## How to REMOVE it completely

Every touchpoint is tagged with the marker `[DATA-SAMPLING]`. To find them all:

```bash
grep -rn "\[DATA-SAMPLING\]" server client
```

Removal checklist:

1. **Delete** `server/aimapper/dataSampling.ts`.
2. `server/aimapper/aimapper.ts`
   - remove the `buildSampleContext` import,
   - in the `generate-join-sql` handler: remove `sampleData`/`sampleValues` from the
     destructured body, the `sampleContext` block, the extra `buildJoinSqlPrompt`
     arg, and `sampledUsed` from the response.
3. `server/aimapper/prompts.ts`
   - remove `renderSampleContext`, the `sampleContext` param on `buildJoinSqlPrompt`,
     and its `${renderSampleContext(...)}` call in the user message.
4. `client/src/lib/aimapperApi.ts`
   - remove `sampleData`/`sampleValues` from `generateJoinSql` opts + body, and
     `sampledUsed` from the response type.
5. `client/src/pages/aimapper/MapperPage.tsx`
   - remove the `Slider` import, the sample-size constants + `estimateSampleTokens`
     helper, the `sampleData`/`sampleValues` state, the `MapperSnapshot.sampleData`
     + `sampleValues` fields (restore + cache-write entries), the `sampleData`/
     `sampleValues` args on the three `generateJoinSql` calls, and the "Sample
     Source Data" toggle + slider block.
6. **Delete this file.**

Then `npm run typecheck && npm run lint` and redeploy.
