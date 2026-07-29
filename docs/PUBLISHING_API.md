# Publishing API

The Axum service is the authoritative boundary for immutable publication. The
MVP exposes public paper routes plus a read-only external-observation route:

- `GET /health`
- `POST /v1/papers`
- `GET /v1/papers/{paper_id}/revisions/{revision}`
- `GET /v1/github/trending`

The generated contract is checked in at `openapi/prodxiv-api.json`.

## Local environment

Copy `.env.example` to `.env` and replace `PRODXIV_PUBLISH_TOKEN` with a random
value containing at least 32 characters. Then start PostgreSQL, the API, and
the static website with Podman:

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

With the API and website running, open `http://127.0.0.1:4321/trending`. The
page reads the latest exact match for `period`, `language`, and
`spoken_language`. A missing scope returns an empty result rather than silently
falling back to a different observation.

Passing `date=YYYY-MM-DD` reads an exact historical snapshot. Each response
also includes the nearest earlier and later imported dates for that scope, plus
the language scopes available on the selected date. The website uses that
metadata for day arrows and language tabs; it does not assume observations
exist for every calendar day or language.

## Publish a paper

Submissions contain Markdown with YAML front matter. They must include a
license and must omit `paper_id`, `published_at`, and `version`; the service
assigns those fields transactionally.

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

Configure each Vercel project under **Settings → Build and Deployment →
Ignored Build Step**:

- `prodxiv-api`: `sh scripts/vercel-ignore-build.sh api`
- `prodxiv-web`: `sh scripts/vercel-ignore-build.sh web`

The existing `sh scripts/vercel-api-ignore-build.sh` API setting remains
supported as a compatibility wrapper. Do not use a shared root `vercel.json`
because the two projects require different targets.

The filter first compares against Vercel's previous deployment SHA. On the
first preview for a new branch, it falls back to the merge base with
`origin/main` when that ref is available and older than the deployment commit.
It builds when neither range can be proven. This fail-open behavior avoids
silently skipping a required deployment.

Set:

- `DATABASE_URL` to Neon's pooled application URL.
- `DATABASE_URL_UNPOOLED` to Neon's direct URL for migrations. The
  provider-neutral name `DIRECT_DATABASE_URL` is also accepted.
- `PRODXIV_PUBLISH_TOKEN` to a secret with at least 32 characters.
- `PRODXIV_PUBLISH_ACTOR` to the audit actor represented by that token.
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
