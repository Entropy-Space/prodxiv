# Publishing API

The Axum service is the authoritative boundary for private drafts and
immutable publication. The MVP exposes draft, public paper, and
external-observation routes:

- `GET /health`
- `POST /v1/drafts`
- `GET /v1/drafts`
- `GET`, `PUT`, and `DELETE /v1/drafts/{paper_uuid}`
- `POST /v1/drafts/{paper_uuid}/approve`
- `POST /v1/drafts/{paper_uuid}/reject`
- `POST /v1/drafts/{paper_uuid}/publish`
- `GET /v1/drafts/{paper_uuid}/revisions`
- `GET /v1/drafts/{paper_uuid}/revisions/{revision}`
- `POST /v1/papers`
- `GET /v1/papers/{paper_id}/revisions/{revision}`
- `GET /v1/github/trending`
- `POST /v1/github/trending/snapshots`

The generated contract is checked in at `openapi/prodxiv-api.json`. Draft
routes are private, use the publishing bearer token in the MVP, and are
described in `docs/DRAFTS.md`.

The website exposes the private `/drafts` review queue. It accepts the same
token from browser HTTP Basic authentication and forwards it server-side; do
not configure `PRODXIV_PUBLISH_TOKEN` on the web project or expose it in client
JavaScript. Any non-empty Basic username is accepted in this MVP, so API audit
events use `PRODXIV_PUBLISH_ACTOR` until real reviewer identity is introduced.

## Local environment

Copy `.env.example` to `.env` and replace `PRODXIV_PUBLISH_TOKEN` and
`PRODXIV_TRENDING_INGEST_TOKEN` with different random values containing at
least 32 characters. Then start PostgreSQL, the API, and the static website
with Podman:

```sh
podman compose up --build
```

`podman compose` delegates to a Compose provider. Install `podman-compose` or
another provider if `podman compose version` reports that none is available.

The services listen on:

- Website: `http://127.0.0.1:4321`
- API: `http://127.0.0.1:3000`
- PostgreSQL: `127.0.0.1:54329`

To run Rust tests directly on the host while PostgreSQL is running:

```sh
set -a
source .env
set +a
bun run test:rust
```

The API runs embedded migrations before it begins serving requests. To run the
same migrations independently for maintenance or diagnosis:

```sh
cargo run -p prodxiv-api --bin prodxiv-migrate
```

## Import a local GitHub Trending snapshot

Start PostgreSQL, then import the checked-in provenance-preserving fixture:

```sh
podman compose up -d postgres
DIRECT_DATABASE_URL=postgres://prodxiv:prodxiv@127.0.0.1:54329/prodxiv \
  bun run import:github-trending examples/github-trending/2026-07-29.json
```

The importer runs migrations, inserts the snapshot and its ordered entries in
one transaction, and is idempotent for the same date, scope, and source
revision. It does not fetch GitHub or alter a previously imported observation.
It accepts multiple JSON paths in one invocation and records successful
zero-entry snapshots, preserving the distinction between an empty Trending
scope and a failed collection attempt.

Snapshot JSON always names its language scope. `language: "any"` is GitHub's
single unfiltered Trending page; concrete language slugs name exact filtered
pages. The storage codec maps `any` to the existing SQL `NULL` representation,
so this terminology change requires no data migration. `all` is a read or
collector selector and is never stored as a snapshot language.

## Collect GitHub Trending daily

The `Collect GitHub Trending` GitHub Actions workflow runs every day at
02:17 UTC against the `production` GitHub Environment. It can also be started
manually, selecting either `production` or `staging`. Configure these values
as GitHub Environment variables and secrets for each target:

- the Actions variable `PRODXIV_API_URL` with that environment's public API
  URL;
- the Actions secret `PRODXIV_TRENDING_INGEST_TOKEN` with the dedicated token
  configured on that API.

`PRODXIV_TRENDING_INGEST_ACTOR` is optional. When it is unset, the workflow
uses `github_actions:daily_trending`; set an environment variable when a
different audit identity is needed. Do not point `staging` at a per-PR Vercel
preview. Preview URLs and their backing databases are ephemeral, whereas
trending snapshots are durable observations. Use a stable staging API and
database for manual non-production ingestion.

The Bun collector fetches the unfiltered `any` page and the configured concrete
language scopes, validates GitHub's current Trending HTML, and creates snapshots using
the same JSON contract as the local fixture importer. It sends each successful
scope to the authenticated API independently. The API validates it again,
records the ingestion actor and idempotency key, and stores the observation in
one transaction. The workflow never receives a database credential or
migration authority. The actor travels in the authenticated request so other
collectors can use their own audit identities.

A structurally valid page with no repositories becomes an empty snapshot.
HTTP failures, challenge pages, malformed repository metrics, and rejected API
requests do not create snapshots, make the workflow fail, and remain visible
in its job summary. Each source revision is a SHA-256 digest of the normalized
ranked entries rather than GitHub's dynamic page markup. Successfully ingested
scopes remain durable when another scope fails, so a manual rerun can recover
the missing observations.

To run the same collector locally:

```sh
captured_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
snapshot_date="${captured_at%%T*}"
PRODXIV_API_URL=http://127.0.0.1:3000 \
PRODXIV_TRENDING_INGEST_TOKEN=replace_with_another_32_random_characters \
PRODXIV_TRENDING_INGEST_ACTOR=local_trending_collector \
  bun run collect:github-trending \
    --snapshot-date "${snapshot_date}" \
    --captured-at "${captured_at}"
```

The default scopes are Any, C#, C++, Dart, Elixir, Go, Java, JavaScript, Julia,
Kotlin, Markdown, PHP, Python, Raku, Rust, Scala, Shell, Swift, TypeScript, Vue,
and Zig. Pass one or more `--language` options to collect only selected scopes;
use `--language any` for only the unfiltered page. `--language all` expands to
`any` plus every configured concrete scope and cannot be combined with another
`--language` value. With no language option, the collector uses the same `all`
expansion.

With the API and website running, open `http://127.0.0.1:4321/trending`. The
page reads the latest exact match for `period`, `language`, and
`spoken_language`. A missing scope returns an empty result rather than silently
falling back to a different observation.

Passing `date=YYYY-MM-DD` reads an exact historical snapshot. Each response
contains `requested_language` and a `snapshots` array. Omitted `language` and
`language=any` select the single unfiltered scope, a concrete slug selects that
exact scope, and `language=all` returns every stored scope for the date in one
response. Each snapshot still has a concrete language value (`any` or a slug),
never `all` or `null`. The response also includes the nearest earlier and later
imported dates for the selector, plus the concrete language scopes available on
the selected date. The website uses that
metadata for day arrows and language tabs; it does not assume observations
exist for every calendar day or language.

## Publish a paper

Submissions contain Markdown with YAML front matter. They must include a
license, use the current schema version 2, and omit `paper_id`, `published_at`,
and `version`; the service assigns those fields transactionally. Historical
schema-version-1 papers remain readable but cannot be submitted as new
revisions.

Paperbot is the preferred client:

```sh
bun run paperbot auth set --api-url http://127.0.0.1:3000
bun run paperbot publish path/to/paper.md
```

To publish another paper about an existing product:

```sh
bun run paperbot publish path/to/paper.md \
  --product-id prodxiv-product:2607.000001
```

Without `--product-id`, publication creates a new product identity. Product
homepage and repository URLs are normalized into `product_resources`; they
also remain historical metadata in the immutable paper source for
compatibility.

GitHub metrics are not paper metadata. Periodic collectors append timestamped
rows to `github_repository_observations`, keyed by a repository resource and
GitHub's stable repository node identifier. A collector must run from an
external scheduler; the API process must not rely on an in-process timer.

Pass `--site-url http://localhost:4321` as well when Paperbot should return the
human-readable paper URL after publication.

For a direct API request, provide an idempotency key that remains stable when
retrying the same exact Markdown:

```sh
jq -n \
  --rawfile source_markdown path/to/paper.md \
  '{source_markdown: $source_markdown}' \
  | curl --fail-with-body \
      --header "Authorization: Bearer ${PRODXIV_PUBLISH_TOKEN}" \
      --header "Content-Type: application/json" \
      --header "Idempotency-Key: example-publication-001" \
      --data-binary @- \
      http://127.0.0.1:3000/v1/papers
```

The first successful request returns `201 Created`. A retry with the same
actor, idempotency key, and Markdown returns the original publication with
`200 OK`. Reusing the key for different Markdown returns `409 Conflict`.

Paper identifiers use `prodxiv:YYMM.XXXXXX`. The suffix is uppercase Crockford
Base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`); lowercase input is accepted and
canonicalized.

Public readers can request the latest revision of each paper with
`GET /v1/papers`. The endpoint accepts `limit` from 1 to 100 and an opaque
`cursor` returned as `next_cursor`. Exact historical revisions remain
available through `GET /v1/papers/{paper_id}/revisions/{revision}`. The legacy
`/versions/{revision}` route remains readable for existing clients.

## Production configuration

The API deploys from the repository-root `Containerfile.vercel` as a separate
Vercel project. Keep the Astro website on its native Vercel project; the local
multi-target `Containerfile` is not the website's production artifact.

The ignored-build commands are checked into the project-specific Vercel
configuration files. The repository-root `vercel.json` selects the API target,
while `apps/web/vercel.json` selects the web target from that project's root
directory. These files override the corresponding **Settings → Build and
Deployment → Ignored Build Step** dashboard values, so a newly connected
project does not silently build every repository commit. The existing
`sh scripts/vercel-api-ignore-build.sh` API setting remains supported as a
compatibility wrapper.

Also enable Vercel's native **Skip deployment** setting for the Bun workspace
when the project configuration supports it. Native skipping avoids allocating
a deployment and concurrent-build slot. The custom ignored-build command is
still required for the Rust API and for repository paths outside Vercel's Bun
workspace graph; Vercel creates a canceled deployment record when that command
exits successfully.

The filter first compares against Vercel's previous deployment SHA. On the
first preview for a new branch, it falls back to the merge base with
`origin/main` when that ref is available and older than the deployment commit.
Vercel uses shallow Git checkouts, so the filter fetches the missing previous
commit or default-branch history before retrying the comparison. The checked-in
commands provide the repository's canonical public HTTPS URL because a Vercel
checkout may not retain a fetchable `origin`; local runs fall back to their
configured Git remote. The filter builds when neither range can be proven or
Git history cannot be hydrated. This fail-open behavior avoids silently
skipping a required deployment. Changes to the ignored-build scripts and
project-specific Vercel configuration are control-plane changes and do not
rebuild either application when their runtime inputs are unchanged.

Set:

- `DATABASE_URL` to Neon's pooled application URL.
- `DATABASE_URL_UNPOOLED` to Neon's direct URL for migrations. The
  provider-neutral name `DIRECT_DATABASE_URL` is also accepted.
- `PRODXIV_PUBLISH_TOKEN` to a secret with at least 32 characters.
- `PRODXIV_PUBLISH_ACTOR` to the audit actor represented by that token.
- `PRODXIV_TRENDING_INGEST_TOKEN` to a different secret with at least 32
  characters. When absent, reading remains available and ingestion returns
  `503`.
- `PRODXIV_BIND_ADDRESS` only outside Vercel when an explicit address is
  required. On Vercel, the API listens on the platform-provided `PORT`.

On the separate `prodxiv-web` Vercel project, set `PRODXIV_API_URL` to the
public HTTPS URL of this API. The website uses it only from its on-demand
server route; do not configure the publishing token on the website.

At startup, the API runs embedded migrations through the direct connection
before opening its pooled application connection. SQLx serializes concurrent
migration runners with a PostgreSQL advisory lock, so only one instance applies
pending migrations and the others observe the completed schema.

Startup locking prevents concurrent migration execution, but it cannot make a
breaking schema change compatible with old API instances during a rolling
deployment. Keep production migrations backward compatible:

1. Expand the schema with additive tables, columns, or indexes.
2. Deploy code that works with both the old and expanded schema.
3. Backfill data separately when required.
4. Remove obsolete schema only in a later release.

The bearer token is intentionally temporary MVP authorization. Replace it with
real user identity before exposing publication to multiple authors. Never put
the token in website client code.
