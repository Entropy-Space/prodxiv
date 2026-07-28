# Publishing API

The Axum service is the authoritative boundary for immutable publication. The
MVP exposes three routes:

- `GET /health`
- `POST /v1/papers`
- `GET /v1/papers/{paper_id}/versions/{version}`

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

## Publish a paper

Submissions contain Markdown with YAML front matter. They must include a
license and must omit `paper_id`, `published_at`, and `version`; the service
assigns those fields transactionally.

Paperbot is the preferred client:

```sh
bun run paperbot auth set --api-url http://127.0.0.1:3000
bun run paperbot publish path/to/paper.md
```

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

Public readers can request the latest version of each paper with
`GET /v1/papers`. The endpoint accepts `limit` from 1 to 100 and an opaque
`cursor` returned as `next_cursor`. Exact historical versions remain available
through `GET /v1/papers/{paper_id}/versions/{version}`.

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
