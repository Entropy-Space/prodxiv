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

Set:

- `DATABASE_URL` to Neon's pooled application URL.
- `DIRECT_DATABASE_URL` to Neon's direct URL for migrations.
- `PRODXIV_PUBLISH_TOKEN` to a secret with at least 32 characters.
- `PRODXIV_PUBLISH_ACTOR` to the audit actor represented by that token.
- `PRODXIV_BIND_ADDRESS` when the platform does not use `0.0.0.0:3000`.

The bearer token is intentionally temporary MVP authorization. Replace it with
real user identity before exposing publication to multiple authors. Never put
the token in website client code.
