# Security notes

Two dependency trees exist here, and they have **different** audit answers. Do not read one as
the other:

| Tree | What it is | Command | Result |
| --- | --- | --- | --- |
| **Production** | what a deployment installs and runs (`npm ci --omit=dev`) | `npm audit --omit=dev` | **0 vulnerabilities** |
| Development | adds the optional official CLI (`@qloo/qloo-harness`) | `npm audit` | **4 findings (2 high, 2 moderate)** |

The four findings are real and are listed below with their IDs. They belong to the optional
CLI's dependency tree; they are **not** in the production tree, because that package is a
devDependency and the default access surface uses Node's built-in `fetch` — no npm HTTP client
is in the request path.

The production tree does contain one npm package, `@vercel/blob`, used only by the
shared-budget adapter. Its own dependency chain pulled in an affected `zod`, so the lockfile
pins a fixed `zod` through an `overrides` entry — see the section below.

## The 4 findings (development tree only)

`npm audit` on the pinned lockfile reports **4 vulnerabilities: 2 high, 2 moderate**.

| Package | Installed | Severity | Advisory | Fix range |
| --- | --- | --- | --- | --- |
| `brace-expansion` (nested under `@earendil-works/pi-coding-agent`) | 5.0.9 | high | GHSA-q2hr-2g5m-vwhr (quadratic expansion DoS), GHSA-qhr7-859c-m2p7 (stack exhaustion), GHSA-6j4f-fj2g-mc7p (stack exhaustion) | `>=5.0.12` |
| `undici` (nested under `@earendil-works/pi-coding-agent`) | 8.9.0 | high | 18 advisories, incl. GHSA-3xpg-4rpp-hhhm (unbounded decompression of compressed responses), GHSA-pmjh-fq2x-6v4x / GHSA-8436-99hf-9mmv (retry-handler response issues), GHSA-2m5v-pch6-74hx (TLS options dropped in `Agent`) | `>=8.12.2` |
| `@earendil-works/pi-coding-agent` | 0.84.2 | moderate | transitive: flagged **because of** its `undici` dependency (advisory range `0.75.4 – 0.85.1`) | needs a newer `undici` |
| `@qloo/qloo-harness` | 0.1.26 | moderate | transitive: flagged **because of** its `pi-coding-agent` dependency | needs a newer `pi-coding-agent` |

The two moderate findings are not separate issues: they are the same two packages seen one level
up the tree.

## Why this was not "fixed" with `npm audit fix`

**We did not run `npm audit fix`, and we did not swap in a fork.** What follows is what was
actually observed on this tree — not a general rule about npm.

### What the two published packages actually ship

```
@qloo/qloo-harness@0.1.26
│   dependency spec pins pi exactly; no npm-shrinkwrap.json, no bundleDependencies
└── @earendil-works/pi-coding-agent@0.84.2
    │   ships npm-shrinkwrap.json (lockfileVersion 3), no bundleDependencies
    │   its shrinkwrap pins: undici 8.9.0, minimatch 10.2.5, brace-expansion 5.0.9
    ├── undici@8.9.0
    └── minimatch@10.2.5 → brace-expansion@5.0.9
```

### What we observed when we tried to override it

Three override shapes, each in its own clean install:

| Attempted override (at the root `package.json`) | Result |
| --- | --- |
| flat: `"undici": "8.12.3"`, `"brace-expansion": "5.0.12"` | `undici@8.9.0` / `brace-expansion@5.0.9` stayed |
| nested: `"@earendil-works/pi-coding-agent": { "undici": "8.12.3", "minimatch": { … } }` | stayed |
| deepest path form | stayed |

Control experiment on the same npm: a flat override of a normal **range** dependency *did* take
effect (`chalk` → `ansi-styles@4.3.0`).

### What is **not** confirmed

npm can override exact transitive versions in general, so we are **not** claiming that it cannot.
The plausible explanation for what we saw is that npm honours a published package's
`npm-shrinkwrap.json` for that package's subtree, and `pi-coding-agent` ships one that pins
exactly these versions — but we did **not** isolate that mechanism, so the root cause is
**unconfirmed**. We also did not try replacing the harness's own dependency on
`pi-coding-agent`, and we stopped there rather than looping through more installs.

### What upstream offers

- `@qloo/qloo-harness` **0.1.26 is the latest published version** (checked in the registry).
- `@earendil-works/pi-coding-agent` has newer releases (up to 1.4.0) with newer `undici` /
  `minimatch` pins, but the harness's dependency spec pins pi exactly, so this tree only moves
  when the harness's own spec moves.

## The `zod` finding in the shared-budget adapter's chain (measured)

`@vercel/blob@2.8.2` → `@vercel/oidc` → `@vercel/cli-config` → `zod@4.1.11`.
`zod < 4.6.6` is affected by GHSA-mrhx-c7xc-m3w5 ("Zod can exhaust memory while validating
oversized constrained collections"). With that chain as installed, `npm audit --omit=dev`
reported **4 high** findings (the same `zod` seen through `@vercel/cli-config`,
`@vercel/oidc` and `@vercel/blob`).

The lockfile pins `zod` to `4.6.7` through npm `overrides`:

```json
"overrides": { "zod": "4.6.7" }
```

Measured in a clean install with the official registry: the installed `zod` becomes `4.6.7` and
`npm audit --omit=dev` reports **0 vulnerabilities**. `4.6.7` is a minor release above the
pinned `4.1.11` (same major), so the API surface the SDK relies on is unchanged. This is an
override of a normal registry dependency — it is verified by an actual install plus audit, not
assumed.

## Reachability (measured, not assumed)

**`brace-expansion` — module is loaded, vulnerable function is not reached by our commands.**
A traced `qloo api search --dry-run` (no request sent) shows `minimatch` and `brace-expansion`
being imported at CLI startup. The vulnerable functions (`expand`, `parseCommaParts`) only run when
a glob is expanded, and in `pi-coding-agent` the only call sites are:

- `dist/core/package-manager.js` — glob matching over package-manager file paths,
- `dist/core/model-resolver.js` — glob matching over model ids.

Neither is on the `qloo api search` / `qloo api insights` path, and the glob patterns come from
that package's own configuration, not from user input (our seed text never reaches them). So this
finding is **not reachable through the Qloo API commands this project uses**.

**`undici` — reachable: it is the CLI's HTTP client.**
`pi-coding-agent/dist/core/http-dispatcher.js` uses `undici.Client`, `undici.Pool`,
`undici.EnvHttpProxyAgent` and `setGlobalDispatcher`, so every API call goes through it. Most of
the 18 advisories target features the CLI does not use (WebSocket permessage-deflate, WebSocket
subprotocol, EventSource parser, the dump interceptor, retry interceptor, shared cookie cache).
The generic HTTP-level ones — most notably unbounded decompression of compressed responses — would
apply if the upstream were malicious or compromised. This is therefore recorded as **reachable in
principle, not exploitable by an outside caller** under the deployment constraints below.

**In the production tree both are absent.** The default access surface is Node's built-in
`fetch` (Node's own bundled undici, patched with Node releases) and imports no npm `undici` and
no `brace-expansion`. The one production package (`@vercel/blob`) is used by the shared-budget
adapter only — it is not in the request path either.

## Mitigations that are in force

- **The origin is pinned.** The instance refuses to start against any host other than the event
  host, and the optional CLI child additionally runs under a single-request gate: one HTTP
  attempt, `GET` only, `/search` and `/v2/insights` only, the configured origin only,
  `redirect: 'error'`. No user-supplied string becomes a URL, and redirects are not followed.
- **Budget and blast radius are bounded.** A request budget is cumulative, persisted and
  decremented before each request; a public instance should be given an explicitly small cap.
- **The default request path has no npm HTTP client.** The direct-HTTP adapter uses Node's
  built-in `fetch` and imports no npm `undici`.
- **The direct-HTTP path is officially allowed but not live-verified here.** The official CURRENT
  developer guide documents direct `GET /search` and `GET /v2/insights` requests (its own examples
  are curl/Python), so the access surface is permitted — but this project has only exercised it
  against a local fake server, never against the live API. The CLI path is the one that was run
  live during development. The UI and `/api/status` report these two facts separately.

## Deployment limitation (what an operator has to accept)

1. The **production** tree installs no npm package, so it carries none of the four findings. The
   four findings remain in the **development** tree: the CLI pins those versions exactly, the
   root overrides we tried did not take effect, and we did not isolate why.
2. Before exposing a public instance: keep the base URL pinned to the event host, keep the
   single-request gate enabled for the CLI path, and give the instance an explicitly sized,
   cumulative request budget.
3. If you install the dev tree to exercise the CLI path, do it on a machine you control; the
   findings are reachable in principle through that package's HTTP client.
4. Re-run `npm audit` when `@qloo/qloo-harness` publishes a newer version, and move the CLI
   version then.
5. **Two budget shapes, and the file one only works single-instance.** The container form keeps
   the counter in a file with a lock (one instance, persistent volume). The serverless form
   keeps it in a private Vercel Blob store: reads bypass the CDN cache, writes are
   compare-and-swap on the ETag, and the counter is initialized once, explicitly. Anything
   uncertain — missing or unreadable state, a missing ETag, a CAS conflict, a store error, an
   exhausted quota — **fails closed**: no request is sent, nothing is retried, nothing is
   refunded. A counter that is missing is never recreated at runtime, so a redeploy cannot
   reset it. The shared path has been checked against a local fake store and the documented SDK
   contract, but **not** against the real store yet.

## Node engine floor

The production path needs **Node ≥ 22** (built-in `fetch`). The optional CLI path needs
**Node ≥ 22.19.0**, because `undici@8.9.0` and `8.12.x` both require it. The provided
`Dockerfile` uses `node:22-alpine`; pin `node:22.19-alpine` if you also want to run the CLI
path. The project's own `engines` field says `>=22`.
