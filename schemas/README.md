# Generated contracts

The JSON Schemas in this directory are generated from the authoritative Rust
models in `crates/prodxiv-domain`. Do not edit the schema files by hand.

Regenerate them from the repository root:

```sh
bun run schema
```

`paper.schema.json` describes the normalized paper document: parsed front
matter in `metadata` and the Markdown body in `markdown`.
`validation.schema.json` describes versioned validation diagnostics.
`validation-policy.json` carries section and profile rules consumed by local
schema-backed validators.

The schemas describe structural validity. Domain validation adds rules that
JSON Schema cannot express cleanly, including required Markdown sections,
cross-references between claims and sources, and publication-only invariants.
Draft validation intentionally allows archive-assigned publication fields to
be absent.
