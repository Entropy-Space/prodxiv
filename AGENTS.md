# AGENTS.md

## Project

prodxiv is a versioned archive of structured product papers. It has two
products:

- **prodxiv web** is the public archive, reader, editor, and publishing
  experience.
- **Paperbot** is a local-first Bun CLI plus an Agent Skill that turns an
  existing repository and its documentation into an initial paper draft.

Read these documents before making product or architecture decisions:

- `docs/PRODUCT_VISION.md`
- `docs/PAPERBOT.md`

## Product principles

- Optimize for durable product knowledge, not launch-page promotion.
- Published paper revisions are immutable. Meaningful changes create a new
  revision.
- Treat limitations and benchmark methodology as first-class content.
- Prefer visible uncertainty over unsupported fluent prose.
- Paperbot may draft and revise, but it must never publish automatically.
- Paperbot should infer implementation and ask authors about intention.
- Keep repository analysis local by default.

## Current architecture

Use a polyglot monorepo with a Bun workspace for TypeScript products and a
Cargo workspace for the authoritative publishing service:

```text
prodxiv/
├── apps/
│   ├── web/                    # Astro website
│   └── paperbot/               # Bun CLI
├── crates/
│   ├── prodxiv-domain/         # Paper model and validation
│   ├── prodxiv-api/            # Axum publishing API
│   └── prodxiv-storage/        # PostgreSQL persistence
├── packages/
│   ├── api-client/             # Generated TypeScript client
│   └── markdown/               # Rendering rules
├── schemas/
│   └── paper.schema.json       # Generated, checked-in contract
├── skills/
│   └── paperbot/               # Portable Agent Skill
├── examples/
│   └── papers/                 # Reference and test papers
└── docs/
```

This tree is directional. Do not create empty packages or abstractions before
the first vertical slice needs them.

The canonical paper model and publication invariants belong in
`crates/prodxiv-domain`. Generate and check in its language-neutral JSON Schema
and the API's OpenAPI document. Generate the TypeScript API client and types
from those contracts. The website and Paperbot must not maintain parallel
hand-written models.

Use:

- Bun for package management, scripts, tests, and the Paperbot runtime.
- TypeScript in strict mode.
- Astro for the website.
- React only for interaction-heavy islands.
- Rust and Axum for the canonical publishing API.
- SQLx and PostgreSQL for transactional persistence.
- Neon Postgres through the Vercel Marketplace in production.
- Podman and a root `Containerfile` for reproducible local development.
- The native Astro Vercel integration for the website.
- A separate Vercel container project for the Axum API.

Do not add a separate search service, vector database, or additional backend
service until a measured requirement justifies the boundary.

The service boundary is deliberate:

- Paperbot performs local analysis and produces a draft.
- The website provides reading and editing experiences.
- The Axum API owns authentication, authorization, identifier allocation,
  immutable revision creation, authoritative validation, moderation, and audit
  records.

## Build order

Work toward the smallest complete loop:

```text
repository
  -> Paperbot scan
  -> private scan manifest
  -> agent-authored paper draft
  -> Paperbot validation
  -> website paper page
```

Prioritize work in this order:

1. Define the canonical paper schema.
2. Write one exemplary product paper by hand.
3. Implement `paperbot scan`, `paperbot draft`, and `paperbot validate`.
4. Package the Paperbot Agent Skill.
5. Render the exemplary and generated papers on one website route.
6. Implement the Axum submission and immutable publication path.
7. Test the complete loop against varied real repositories.

Do not start with accounts, feeds, comments, moderation, embeddings, or
advanced AST analysis unless the current task explicitly requires them.

## Paperbot boundaries

The CLI owns deterministic operations. The skill owns agent judgment and
workflow orchestration.

The CLI should:

- Work independently of any particular model provider.
- Provide human-readable output and versioned JSON output.
- Use snake_case for every serialized field.
- Write machine-readable results to stdout and diagnostics to stderr.
- Use documented, stable exit codes.
- Respect `.gitignore` and explicit user exclusions.
- Exclude credentials, environment files, user data, generated code, and
  vendored dependencies by default.
- Show which files were selected for local analysis.
- Never fabricate benchmarks or treat marketing copy as established fact.
- Require explicit confirmation for submission or any remote write.

The skill should:

- Follow the open Agent Skills `SKILL.md` structure.
- Remain a thin adapter around the CLI.
- Use relative references within its skill directory.
- Keep detailed policies and templates in `references/` or `assets/`.
- Work with any skills-compatible agent that can execute the CLI.
- Ask the author targeted questions when motivation, history, tradeoffs, or
  lessons are not explained by repository contents.

Distribute Paperbot as editable TypeScript source and as Bun-compiled
executables for supported platforms.

## API and publishing boundaries

The Axum API is authoritative. Paperbot and the website may perform fast local
validation, but the API must validate every submission again.

The API must:

- Allocate paper identifiers and version numbers transactionally.
- Treat every published revision as immutable.
- Associate authors and source Markdown with the exact paper revision they
  belong to.
- Reject unsupported schema versions with a useful diagnostic.
- Require authorization for draft access, submission, and revision creation.
- Keep publication and moderation operations auditable.
- Avoid relying on writable container filesystems or in-process job state.

Keep HTTP handlers thin. Domain rules belong in `prodxiv-domain`, and database
operations belong in `prodxiv-storage`.

## Paper and Markdown rules

- Use Markdown as the authoring source.
- Support a documented CommonMark/GFM-compatible subset.
- Sanitize rendered HTML.
- Preserve raw Markdown alongside rendered output.
- Validate required metadata and recognized sections through the canonical
  schema.
- Keep published source and version identifiers reproducible.
- Do not silently rewrite published paper content.

## Code conventions

- Use 2 spaces for indentation where the language formatter permits it. Follow
  `rustfmt` for Rust.
- Prefer Rust. Prefer TypeScript over JavaScript.
- Enable strict type checking and avoid `any`.
- All fields that may be serialized into strings or JSON must use snake_case.
  This applies to fields, not type or function names.
- Prefer small modules with explicit dependencies over broad utility files.
- Keep domain logic out of CLI argument handlers and UI components.
- Validate data at filesystem, process, network, and database boundaries.
- Prefer code quality and clear ownership over minimizing the size of a change.
- Treat examples as representative cases and update analogous code when the
  same rule applies.

## Tests and verification

- Add or update tests with behavior changes.
- Prefer fixture-based and golden-file tests for scanning, scan manifests,
  Markdown output, and diagnostics.
- Test malformed input, ignored files, incomplete drafts, and sensitive-file
  exclusions.
- Keep at least one end-to-end fixture that exercises the complete
  repository-to-rendered-paper loop.
- Run the narrowest relevant checks during iteration and the full available
  suite before handing off completed work.
- Do not claim a command passed unless it was run successfully.

When scripts are introduced, expose consistent root commands for formatting,
linting, type checking, testing, and building. Until those commands exist, do
not invent them in status reports.

## Planning and communication

- Think broadly and challenge assumptions during planning.
- Ask concise, high-leverage questions when intent or business rules are
  genuinely unclear.
- When asked "why," treat it as a potentially suspicious issue: classify the
  issue, explain whether it is acceptable, and recommend a better approach
  when appropriate.
- Separate verified facts, inferences, and unresolved decisions.
- Preserve unrelated user changes and keep commits focused.

## Deployment

- Never deploy without an explicit user request.
- Never deploy to `chatgpt.site`.
- Local containers must work with Podman.
- Run local PostgreSQL through the Podman development environment.
- Use Neon Postgres through the Vercel Marketplace in production.
- Use pooled PostgreSQL connections for application traffic and direct
  connections for migrations and administrative operations.
- Keep the API and database in nearby regions.
- Store paper metadata, Markdown, and audit data in PostgreSQL.
- Store large images, archives, and other binary assets in object storage.
- Keep runtime state outside the container filesystem.
- Deploy the Astro website through Vercel's native Astro integration.
- Deploy the Axum API as a separate Vercel container project.
- Do not assume the local Podman container is the production artifact.
