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

```sh
jq -n \
  --rawfile source_markdown path/to/paper.md \
  '{source_markdown: $source_markdown}' \
  | curl --fail-with-body \
      --header "Authorization: Bearer ${PRODXIV_PUBLISH_TOKEN}" \
      --header "Content-Type: application/json" \
      --data-binary @- \
      http://127.0.0.1:3000/v1/papers
```

Paper identifiers use `prodxiv:YYMM.XXXXXX`. The suffix is uppercase Crockford
Base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`); lowercase input is accepted and
canonicalized.

## Production configuration

The API deploys from the repository-root `Containerfile.vercel` as a separate
Vercel project. Keep the Astro website on its native Vercel project; the local
multi-target `Containerfile` is not the website's production artifact.

Set:

- `DATABASE_URL` to Neon's pooled application URL.
- `DATABASE_URL_UNPOOLED` to Neon's direct URL for migrations. The
  provider-neutral name `DIRECT_DATABASE_URL` is also accepted.
- `PRODXIV_PUBLISH_TOKEN` to a secret with at least 32 characters.
- `PRODXIV_PUBLISH_ACTOR` to the audit actor represented by that token.
- `PRODXIV_BIND_ADDRESS` only outside Vercel when an explicit address is
  required. On Vercel, the API listens on the platform-provided `PORT`.

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
