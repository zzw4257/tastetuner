# TasteTuner

A taste-first movie picker built on Qloo. Type a film you like, pick the right entity when the
title is ambiguous, and get films ranked from data the service actually returned — with the
ranking explained field by field.

The product is a **deterministic pipeline**, not a black box: it resolves a title, asks for one
batch of candidates, then re-ranks that frozen set locally and shows where every number came
from. No request is made while you move the sliders.

## How it works

1. **Resolve** — the title is looked up through Qloo's search. If several real entities match,
   you pick from the real options; nothing is guessed.
2. **Disambiguate** — the confirmed entity id is the input to the recommendation call.
3. **Candidates** — one recommendation request (`GET /v2/insights`, movie type, `take 20`) returns
   films with affinity, popularity, tags and explainability attribution — **only the fields the
   service actually returned**; anything missing is simply absent, never filled in with a
   guess.
4. **Re-rank locally** — three weights (affinity, popularity, tag similarity) and two hard
   constraints (max content rating, min release year) re-order and filter the **already fetched**
   set. Moving a slider issues no request.
5. **Show the evidence** — each candidate shows its service fields, the local score, and the
   attribution naming the **seed** (not an opaque id).

Failure states are explicit: *no results*, *upstream error* (with a working retry), *not
configured*, and the labelled synthetic offline demo are four different states. The synthetic
demo is never used as a fallback for a failed live call.

## Requirements

- Node.js ≥ 22 — the default access surface is Node's built-in `fetch`; the request path
  pulls in no npm HTTP client
- One runtime dependency: `@vercel/blob` — used **only** by the shared-budget adapter
  (`scripts/vercel-blob-adapter.mjs`). It is not in the request path.
- Optional, development only: the official Qloo CLI (`@qloo/qloo-harness`, a devDependency).
  It needs Node ≥ 22.19 (its HTTP client requires it) and is kept as a compatibility path, not
  as the shipped default.

## Quick start

```sh
npm ci --registry=https://registry.npmjs.org   # pinned lockfile, official registry
npm run build   # tsc src/ -> dist/assets/, public/ -> dist/
npm run serve   # http://127.0.0.1:4173
```

Without credentials and without an explicit request budget the server sends **no live request**
and the UI shows the "not configured" state. The synthetic offline demo appears only after you
switch to it in the developer diagnostics panel.

To run against the live service you must provide a credential **and** explicitly enable a
request budget:

```sh
export QLOO_CREDENTIALS_FILE=/app/.taste-tuner/credentials.json   # {"apiKey":"…"} — never commit
export QLOO_BASE_URL=https://hackathon.api.qloo.com
export QLOO_TRUSTED_BASE_URL=https://hackathon.api.qloo.com
export QLOO_REQUEST_BUDGET=200        # cumulative cap; unset means no live calls at all
npm run serve
```

The budget is persisted on disk, decremented **before** a request goes out, and never topped up
automatically. The default access surface is the direct HTTP adapter: one `GET`, no redirect
following, the event host only, and no npm HTTP client in the request path. The optional CLI
path additionally runs under a single-request gate: one HTTP attempt, `GET` only, `/search` and
`/v2/insights` only, the configured origin only, redirects refused.

## Agent-callable tools

`scripts/tool.mjs` exposes the same pipeline as structured tools with JSON Schemas, so an
external agent can drive it:

```sh
node scripts/tool.mjs list-tools
node scripts/tool.mjs call resolve_seed '{"seed":"<title>","entity_type":"movie"}'
node scripts/tool.mjs call get_candidates '{"entity_id":"<id>","limit":20}'   # smaller limits are allowed
node scripts/tool.mjs call reorder_candidates '{"candidates":[…],"weights":{…}}'
```

`resolve_seed` and `get_candidates` call the running app's own HTTP API, so budgets,
credentials, parsing and re-ranking are the production path — not a second implementation.
`reorder_candidates` reuses the production ranker locally and makes no request. Point
`TASTE_TUNER_BASE_URL` at a live instance, or at a saved-response replay server to work from
cached data without issuing API calls.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address. Keep loopback unless a proxy or container network is in front. |
| `PORT` | `4173` | Listen port. |
| `QLOO_REQUEST_BUDGET` | unset | Cumulative cap on live requests. **Unset means no live requests.** |
| `QLOO_REQUEST_BUDGET_PHASE` | unset | Ledger name; separates ledgers per purpose. It is a cap, not a switch. |
| `QLOO_BASE_URL` | event host | API base URL. |
| `QLOO_TRUSTED_BASE_URL` | same as base | Explicit trust for the base URL, as the official CLI requires. |
| `QLOO_CREDENTIALS_FILE` | `.taste-tuner/credentials.json` | Server-side credential file. Read in memory; never logged, never sent to the browser. |
| `QLOO_ACCESS_SURFACE` | `http` | `http` = direct HTTP adapter (Node's built-in `fetch`, default) or `cli` = official CLI (development/compatibility path; needs the dev-only `@qloo/qloo-harness`). |
| `QLOO_DURABLE_BUDGET` | unset | `1` = keep the request budget in **shared storage** instead of a local file. Required on serverless platforms: without a local filesystem every invocation would start from zero and a global cap would not be a cap. |
| `QLOO_DURABLE_PHASE_ID` | unset | The shared counter's identity. Every deployment and environment that should share one cap uses the **same** value; redeploying never resets the count. |
| `QLOO_BLOB_ADAPTER` | unset | Path to the server-side storage adapter module. `scripts/vercel-blob-adapter.mjs` ships with this repository. |
| `QLOO_REQUEST_BUDGET_CUTOFF` | unset | ISO timestamp. After it, no request is sent at all. The shared budget requires it. |
| `TASTE_TUNER_BASE_URL` | `http://127.0.0.1:4173` | Target app for the tools. |
| `TASTE_TUNER_SOURCE_LABEL` | `app` | Label recorded in tool output (e.g. `replay`). |

## Deployment

Two shapes are supported; pick one per deployment.

### A. Container (single instance)

A `Dockerfile` is included (it is not built or published by this repository):

- one long-running Node process, **single instance** — the budget ledger is a file with a lock;
- mount a **persistent volume** at `/app/.taste-tuner` so the ledger survives restarts;
- put the credential file on that volume; it is never part of the image;
- set `HOST=0.0.0.0` only when a proxy or container network expects it;
- run with a separate, explicitly sized budget for public use. Do not reuse a development
  ledger.

The file ledger is what makes this shape **single-instance**: the counter and its lock live on
one filesystem, and two processes would each keep their own copy of the count.

### B. Serverless (Vercel) — shared budget

`vercel.json` + `api/[...path].js` are included: the build output is served by the platform and
the function handles `/api/*`. On such a platform the file ledger **does not work** — every
invocation would start from zero, so the cap would not be a cap. The budget has to live in
shared storage:

- `QLOO_DURABLE_BUDGET=1`, `QLOO_DURABLE_PHASE_ID=<one id shared by every deployment>`,
  `QLOO_BLOB_ADAPTER=./scripts/vercel-blob-adapter.mjs`, `QLOO_REQUEST_BUDGET=<cap>`,
  `QLOO_REQUEST_BUDGET_CUTOFF=<ISO deadline>`;
- the counter lives in a **private** Vercel Blob store; reads bypass the CDN cache and every
  write is a compare-and-swap on the ETag, so two concurrent invocations cannot both consume
  one unit;
- the store is initialized **once, explicitly** (`node scripts/init-durable-budget.mjs`).
  Nothing initializes itself at runtime: a missing counter means "refuse to send", never
  "start over";
- anything uncertain — missing state, unreadable state, a missing ETag, a CAS conflict, a store
  error, an exhausted quota — **fails closed**: no request is sent, nothing is retried, nothing
  is refunded.

The adapter never reads a token itself: the Vercel Blob SDK picks up the project's OIDC
credentials (`VERCEL_OIDC_TOKEN` + `BLOB_STORE_ID`) and refreshes them.

## Tests

```sh
npm run typecheck
npm run build
npm test
```

The suite uses hand-written **synthetic** fixtures only — independently constructed, borrowing just
the field schema (fake ids, fake scores, fake metadata) — so a fresh clone passes without any
private file. Tests that would need saved service responses
are **opt-in**: set `TASTE_TUNER_REPLAY_DIR` to a private directory of saved responses and they
run; without it they skip with a clear reason. There is no mock fallback in the product path.

## License

MIT — see [`LICENSE`](LICENSE). The choice was made on 2026-10-29; the reasoning is recorded in
`LICENSE.RECOMMENDATION.md`. The license covers the code only: **no Qloo response data or
derived record may be published in this repository**, whatever the license says.

## Known dependency advisories

Two trees, two different answers — do not read one as the other:

| Tree | Command | Result |
| --- | --- | --- |
| **Production** (what a deployment installs and runs) | `npm audit --omit=dev` | **0 vulnerabilities** |
| Development only (the optional official CLI) | `npm audit` | **4 findings (2 high, 2 moderate)** |

The four findings all live in the optional CLI's own dependency tree
(`@qloo/qloo-harness` → `@earendil-works/pi-coding-agent` → `undici@8.9.0`,
`brace-expansion@5.0.9`). That package is a **devDependency**: it is not installed by
`npm ci --omit=dev` and it is not in the request path of the default access surface, which uses
Node's built-in `fetch`. The findings are still real for anyone who installs the dev tree, so
they are listed with their IDs in [`SECURITY.md`](SECURITY.md) rather than hidden. Read it before
installing the optional CLI path.

The one runtime dependency (`@vercel/blob`, used by the shared-budget adapter) pulls in `zod`
through `@vercel/oidc`; `zod@4.1.11` was affected by an advisory, so the lockfile pins
`zod@4.6.7` through an `overrides` entry. That is why the production audit is clean — see
[`SECURITY.md`](SECURITY.md) for the measured details.

## What the product does

- **English by default.** Navigation, labels, buttons, explanations, errors, loading and empty
  states, accessibility names, mode disclosures and metadata are all English. Original titles are
  kept as the service gives them — nothing is translated that the service did not translate.
- **The genuine count.** The service decides how many similar films come back (the official
  Insights default is 20, up to 50). The list shows them: the first batch is laid out, the rest
  are one "show more" away, and the status line always reports the **real** number — not how many
  happen to be on screen. Reordering and filtering happen locally on the candidates already
  fetched, so they cost no budget.
- **One genre out.** Only films come back, even when the seed is an artist.
- **Offline demo stays separate.** The synthetic scenario is a deterministic local control with
  its own labels; it is never presented as a live result, and a failed live call never falls back
  to it.

## What crosses the public boundary

The `/api/resolve` and `/api/candidates` responses carry **only the parsed fields** the app
needs — identity, details, tags, contributions, ranking inputs. The upstream payload itself
(a few megabytes per call) never leaves the server: it is projected field by field, so an
internal field cannot slip out by accident. A regression test plants a sentinel inside the raw
payload and asserts it never appears in an API response.

## Limitations

- The hosted instance is scoped to the event host, movie entities and a cap of 20 candidates.
- The artist-seed entry point is not enabled on that scoped instance.
- The default access surface (direct HTTP) has only been exercised against a local fake server —
  it has **not** been run against the live API. The optional CLI path is the one that was
  exercised live during development.
- The earlier live runs asked for five results because five was a probe cap. The product now
  asks for the official default of twenty; a live run with twenty has not been made yet.
- The shared-budget path (serverless deployment) has been checked against a local fake store and
  the documented SDK contract, but **not** against the real store yet. Until that is verified,
  treat the shared counter as unproven and keep the request budget small.
- External review links are service-provided URLs; their availability is not verified here.
