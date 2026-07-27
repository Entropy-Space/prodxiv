FROM docker.io/library/rust:1.97-slim-bookworm AS api-builder

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY migrations ./migrations
RUN cargo build --locked --release -p prodxiv-api \
  --bin prodxiv-api \
  --bin prodxiv-migrate

FROM docker.io/library/debian:bookworm-slim AS api

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=api-builder /app/target/release/prodxiv-api /usr/local/bin/prodxiv-api
COPY --from=api-builder /app/target/release/prodxiv-migrate /usr/local/bin/prodxiv-migrate
USER 10001:10001
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/prodxiv-api"]

FROM docker.io/oven/bun:1.3.13-alpine AS web-builder

WORKDIR /app
COPY package.json bun.lock ./
COPY apps ./apps
COPY examples ./examples
COPY packages ./packages
COPY schemas ./schemas
RUN bun install --frozen-lockfile
RUN bun run build:web

FROM docker.io/library/nginx:1.29-alpine AS web

COPY --from=web-builder /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
