# Paperbot

## Purpose

Paperbot turns an existing codebase and its documentation into an initial
product paper draft.

It is a research assistant for authors, not a holder of publication
credentials. Its role is to reduce the work required to create a thoughtful
first draft while preserving traceability and the credibility of prodxiv. A
separate host scheduler may release unchanged bot-owned evaluation drafts
under the constrained policy below.

The guiding rule is:

> Infer implementation. Ask about intention.

Code can reveal architecture, dependencies, features, tests, releases, and
sometimes performance characteristics. It cannot reliably explain why a
product exists, why alternatives were rejected, or what its creators learned.
Paperbot should describe what it can observe and turn missing context into
specific author questions.

Paperbot maintains a deliberate voice boundary. The evidence ledger is neutral
research material: it refers to the product by name and never speaks as `we`.
The paper is a disclosed draft written on behalf of its credited product
authors, so its narrative uses `we`, `our`, and `us` for their work and
decisions. Writer metadata names Paperbot and its model. First-person voice
does not relax evidence requirements; unsupported intention, history, and
lessons remain questions until the author answers them.

The draft is organized around the problem the product solves. Background
describes that problem, the people affected, its constraints, and why it is
difficult. Motivation explains how and why the authors pursue their solution.
Related Work describes how other identifiable work approaches the same problem.
Core Features maps mechanisms back to those problem constraints. The current Pi
workflow does not browse the web, so missing external Background or Related
Work evidence remains visible for later research rather than being fabricated.

## Inputs and outputs

Paperbot may analyze:

- A local repository.
- A public repository URL.
- A private repository with explicit authorization.
- Product documentation selected by the author.
- Optional notes and answers supplied during an author interview.

The scanner produces a private manifest containing the repository revision and
the paths and types of selected files. The manifest coordinates local analysis;
it is not part of the published paper format.

The primary output is a private Markdown draft following the prodxiv paper
structure. The draft should leave unanswered questions and incomplete sections
visible instead of filling them with speculation.

## Drafting workflow

1. **Connect a source.** The author selects a repository and any additional
   documents.
2. **Confirm scope.** Paperbot shows which directories and files it may read
   and which are excluded.
3. **Create a scan manifest.** The CLI records the repository revision and
   selected file inventory.
4. **Build an evidence ledger.** An evidence session reads the bounded source
   bundle through a host-numbered line view, selects inclusive source spans,
   and records observations, qualified inferences, contradictions, unknowns,
   and candidate questions in neutral language that identifies the product by
   name.
5. **Materialize and validate evidence.** The host resolves each selected span
   against the private source snapshot, extracts the exact original text, and
   records its source ID, locator, and digest before any prose is drafted. The
   model never reproduces evidence excerpts. This integrity gate does not claim
   to prove semantic entailment.
6. **Collect related-work inputs.** The host may record public reference URLs,
   but a URL alone cannot support a factual claim. The current Pi workflow
   keeps URLs reference-only; a future collector must snapshot and validate
   their contents before admitting them as external evidence.
7. **Generate a private draft.** A separate author session writes on behalf of
   the credited product authors in first-person plural voice, completes
   problem-centered sections supported by validated repository evidence or
   author statements, and leaves uncertain details as questions.
8. **Interview the author.** The same author session asks a short, adaptive set
   of questions about motivation, background, alternatives, tradeoffs, and
   lessons.
9. **Revise collaboratively.** Author answers are incorporated without
   overwriting deliberate manual edits.
10. **Review and approve.** The author reviews privacy, accuracy, and
    completeness before any submission.
11. **Publish explicitly.** After approval, the CLI submits the exact reviewed
    Markdown to the authoritative API and reports its allocated identifier.

## Example draft behavior

```markdown
# Motivation

> Author input required:
> What user problem originally motivated this project?
> Why were existing tools insufficient?

# Core Features

## Local-first persistence

We keep workspace data locally and synchronize it asynchronously.

> Author review:
> Is offline operation a product goal or only an implementation detail?

# Limitations

No reproducible benchmark results were found, so this draft omits a
Benchmarks section. It does not make performance claims.
```

Paperbot should never turn missing context into polished but unsupported prose.

## CLI and package boundaries

Paperbot has one public command surface: `paperbot`. The Bun source entry and
the compiled executable dispatch the same commands, preserve the same JSON
formats and exit codes, and do not expose a separate executable for an
internal package.

The workspace separates deterministic capabilities from the CLI shell:

- `apps/paperbot` owns argument parsing, terminal output, progressive skill
  guidance, and the current agent and publishing adapters.
- `packages/paperbot-core` owns stable exit-code errors, scan-manifest
  validation, draft scaffolding, and canonical paper validation.
- `packages/paperbot-source` owns local Git inspection, safe repository file
  selection, shared file classification, and the read-only public GitHub
  repository source client.

Dependencies point toward the deterministic core:

```text
paperbot CLI -> paperbot-source -> paperbot-core
             -> paperbot-core
```

The shared canonical paper JSON Schema is exported by
`@prodxiv/contracts/paper-schema`. Both Paperbot and the website consume that
generated artifact, so validation does not rely on a fragile repository-relative
schema path.

Paperbot exposes deterministic operations through a separate machine-facing
`tools` interface:

```text
paperbot tools list
paperbot tools describe paper_validate
paperbot tools repo_scan . --format json
paperbot tools paper_scaffold scan.json
paperbot tools paper_validate paper.md --format json
```

The direct tool commands use normal CLI arguments. JSON is output only, not a
request envelope. `repo_scan --format json` emits the canonical scan manifest
that can be passed to `paper_scaffold`; `paper_scaffold --format json` emits
its validation report and generated Markdown; and `paper_validate --format
json` emits the validation report. The catalog covers only deterministic
repository and paper operations. Skill discovery and reading remain under the
`skills` command, prompt rendering remains internal to `agent`, and `auth` and
`publish` are intentionally excluded from the tool catalog. Publication remains
an explicit human-authorized remote write.

For a native executable on the current platform, run:

```sh
bun run build:paperbot
```

It writes `apps/paperbot/dist/paperbot`, which is intentionally ignored and is
not a release artifact for another platform. The Paperbot test suite compiles a
fresh binary and verifies `--version`, `skills`, and the direct `tools`
commands from a clean working directory, along with safe failure paths for the
lazily loaded agent commands.

## Pi agent workflow

`paperbot agent` is an optional, local-orchestrated drafting workflow. It uses
the Pi SDK with `deepseek-v4-flash` by default, but it is deliberately separate
from deterministic `tools` commands and the explicit `publish` command. Those
commands do not require a model key or start Pi.

Configure one of the following model connections before starting an agent run:

- **Local model router:** set
  `PAPERBOT_MODEL_BASE_URL=http://127.0.0.1:4141/v1`. When the router requires
  client authentication, set either `PAPERBOT_MODEL_API_KEY` or `TOKN_API_KEY`
  through the user's normal secret-management mechanism. When loopback client
  authentication is disabled, no Paperbot API key is required; do not invent a
  placeholder secret. Keep any upstream-provider credential in the router, not
  in a Paperbot command, manifest, paper, or run artifact. Paperbot accepts
  only anonymous loopback HTTP(S) URLs for this setting.
- **Direct DeepSeek:** set `DEEPSEEK_API_KEY` through the user's normal
  secret-management mechanism. This remains supported when no local router is
  configured. Never place that key in a command argument, batch manifest,
  paper, or run artifact.

For example, a router without client authentication needs only:

```sh
export PAPERBOT_MODEL_BASE_URL=http://127.0.0.1:4141/v1
```

Then create a private draft from a local Git worktree or an anonymous canonical
public GitHub repository URL:

```sh
bun run paperbot agent run https://github.com/different-ai/openwork \
  --output ./paperbot-runs/openwork \
  --allow-remote-model \
  --mode interactive \
  --feedback sync \
  --model deepseek-v4-flash
```

Paperbot exposes an interactive drafting mode with two feedback transports,
and an unattended auto mode:

- `--feedback sync` requires an interactive terminal. When the author session
  asks questions, Paperbot shows each question and its reason, records the
  answers as private author evidence, and continues in the same invocation.
  A successful invocation ends at `needs_author_review` and seals exactly one
  final ZIP. Up to three question rounds may occur before that checkpoint.
- `--feedback async` is the default and works without an interactive terminal.
  Paperbot writes `questions.md`, ends at `awaiting_author`, and seals a ZIP.
  The author later supplies a Markdown answer file with `agent resume
<run-directory> --answers <answers.md> --allow-remote-model`. Each async
  resume is a new audited invocation and preserves every earlier ZIP.
- `--mode auto` has no feedback transport and rejects `--feedback`. Paperbot
  never enters `awaiting_author` or accepts a later author-answer resume. It
  records material working assumptions in `assumptions.json`, renders them as
  explicitly unverified and conditional in the private paper, and keeps open
  issues in `questions.md`. A successful run ends at `needs_author_review` and
  seals exactly one `*_final.zip`.

The run record stores `mode` and the selected `feedback` value; auto uses
`feedback: none`.
Runs created before these fields existed are interpreted as interactive async
runs and remain safely resumable. `agent run` defaults to interactive async;
`agent batch` defaults to auto and accepts `--mode interactive` when a queued
author interview is desired instead. Batch manifests remain schema version 1;
batch reports are schema version 2 and record the requested mode.

Agent commands write a compact live transcript to stderr while preserving
stdout for their existing text or versioned JSON result. Concurrent batches
prefix every line with the project index, total, and canonical public
repository name. Model inputs and parsed outputs are represented by
deterministic summaries rather than excerpts:

```text
paperbot: [1/3 owner/repo] [evidence] user: Analyze 16 pinned source files and build a selective evidence ledger
paperbot: [1/3 owner/repo] [evidence] assistant: Returned 13 evidence candidates, 2 contradictions, 4 unknowns, and 3 questions (41.2s, tokens=42150/2840, response=8.0KiB)
paperbot: [1/3 owner/repo] [evidence] host(validate_evidence): retrying — Deterministic validation failed; requesting correction 1/1
```

`user` identifies a host-generated prompt summary, `assistant` identifies a
summary derived from a parsed structured response, and `host(operation)`
identifies deterministic orchestration such as source acquisition, validation,
or checkpoint sealing. `tool(name)` is reserved for a future genuine
model-requested tool call; the current sessions have no tools. Progress never
prints prompts, replies, evidence excerpts, draft prose, author answers, or raw
provider response bodies. Provider failures are reduced to a category and safe
status code. Pass `--quiet` to suppress this live transcript. `--format json`
continues to emit exactly one machine-readable result on stdout.

For a public GitHub source, Paperbot uses the repository owner as the default
organization author, represented by a namespaced ID such as `github:owner`.
It never inspects commits, contributors, or commit email addresses to derive
authorship. Repeatable `--author` values replace that default with explicit
person authors.

Paperbot also snapshots up to ten public GitHub releases and their bounded
release notes. A stable release deterministically supports `launched`; when no
stable release exists, a GitHub prerelease or an explicitly marked alpha,
beta, preview, or release candidate supports `public_beta`. No supporting
release leaves status as `unknown` and `unverified`. `--status` overrides this
inference with an explicit declaration. Paperbot does not infer `concept`,
`private_beta`, or `discontinued` from repository activity. Local repository
analysis remains network-free: it may use a GitHub origin for owner attribution
but leaves status unknown unless `--status` is supplied.

Every generated paper records `paperbot`, its version, a safe generation ID,
and the requested model as its agent writer. The private run record separately
preserves the exact build, prompt-set, lockfile, and observed-model provenance.
Agent-only papers omit `communication_email`; that optional field is
reserved for papers with a credited human writer and is never inferred.

`--allow-remote-model` is required even for a public source and a loopback
model router. It confirms that the bounded selected source bundle may be sent
to the configured model or routed onward by that gateway. The agent never
reads Paperbot publishing credentials and has no publication capability.

For a remote source, Paperbot accepts only
`https://github.com/<owner>/<repo>` (optionally ending in `.git`). It resolves
the requested or default ref to an exact commit SHA through GitHub, rejects
private repositories, unsafe paths, malformed or truncated trees, and
oversized content. Well-formed Git symlinks and submodules are counted and
skipped without being followed or fetched. Their counts remain in the private
source-selection artifact. Paperbot then verifies each selected raw file
against its Git blob SHA before reading a small SHA-pinned UTF-8 source bundle.
The default sixteen-file
selection recognizes supported implementation languages, including Zig, and
reserves deterministic coverage for architecture or design documentation,
core implementation, public interfaces, verification, performance, and
operational metadata when those areas exist. README-linked paths remain
preferred, but cannot consume the entire bundle. It does not clone the
repository, run its code, install dependencies, or fetch arbitrary URLs.

Every Paperbot-started Pi session immediately creates a Pi-native, append-only
JSONL file inside the mode-`0700` run directory. Session files are mode `0600`,
remain local, and are never included in a submission or publication. They
contain the complete prompts, model replies, and usage metadata, so the whole
run directory must be treated as private. Workflow artifacts record each
session's relative path, Pi session ID, and SHA-256 digest; Paperbot verifies
those values before reopening a session. An `agent run` paper workflow uses
exactly two such logical sessions: an evidence session and an author session.
Every Pi workflow uses an in-memory credential store. Built-in tools,
extensions, skills, prompt templates, themes, and repository context-file
discovery remain disabled. The model receives host-built bundles; it cannot
use a shell, read arbitrary files, browse the web, access environment
variables, or call `publish`.

The agent writes a new private run directory with:

- `run.json` — schema-versioned state, requested model, source revision,
  generation ID, exact Paperbot producer provenance, bounded workflow counters,
  session records, checkpoint records, artifact paths, rollout totals, and
  draft/paper SHA-256 values. A run resumed by a different build retains the
  prior producer in `producer_history` and uses the new build for later events;
- `events.jsonl` — a Paperbot-owned, hash-chained rollout log with workflow-state snapshots,
  semantic model operations, prompt and response digests, durations,
  provider/model observations, token usage, failures, and checkpoint
  boundaries. Full private prompts and replies remain in the Pi session
  artifacts;
- `source.json`, `scan.json`, and `source/` — the bounded private source
  snapshot, original scan inventory, repository-owner context, and any bounded
  GitHub release metadata and notes used for status inference;
- `evidence-candidates/`, `evidence-analysis.json`, and `evidence.jsonl` — the
  evidence session's candidate checkpoints, unresolved analysis, and the
  integrity-validated claim ledger. Candidate schema version 2 stores neutral
  claims and model-selected inclusive line ranges, not copied excerpts. The
  host materializes each repository or snapshotted release-note item in
  `evidence.jsonl` with an `evidence_id`, exact excerpt and digest, source ID,
  line locator, confidence, and status. Supplied external URLs remain
  reference-only until their contents are explicitly snapshotted;
- `sessions/evidence/` and `sessions/author/` — the two private Pi-native JSONL
  conversations referenced and integrity-bound by `run.json`;
- `draft.md` and `drafts/` — the editable first draft and immutable accepted
  draft checkpoints with deterministic validation reports;
- `questions.jsonl`, `questions.md`, and `answers/` — the bounded author
  interview protocol and copied answer checkpoints;
- `assumptions.json` — structured material assumptions, their reasons, and the
  evidence IDs that bound them; assumptions are never promoted to evidence;
- `paper.md` and `validation.json` — the final generated private paper and
  current deterministic validation report.

At every `awaiting_author`, `needs_author_review`, or `failed` stopping point,
Paperbot writes a new immutable ZIP beside the live run directory under a
private `checkpoints/` directory. The ZIP contains the complete run snapshot
and a `manifest.json` listing every archived path, byte count, and SHA-256
digest. Resume never overwrites an earlier ZIP; it creates the next numbered
checkpoint and retains the live directory for continued work. Checkpoint ZIPs
are private debugging artifacts and are never published or submitted.
Successful auto runs have no intermediate stop, so their single terminal
archive is named `*_final.zip`.
If a process was interrupted after persisting a resumable stopping state but
before recording its ZIP, the next `agent resume` first creates a `recovered`
checkpoint before mutating that run.

The evidence session sees the bounded source bundle and returns evidence, not
paper Markdown. The host gives every source line a display-only absolute number.
The model selects narrow inclusive line ranges and builds a selective,
high-information ledger covering product purpose, mechanisms, interfaces,
guarantees, verification, operations, performance methodology, tradeoffs, and
limitations rather than collecting incidental constants or file-level trivia.
Its claims and analysis refer to the product neutrally by name. The host
extracts exact text from the original snapshot; display line numbers never
enter the excerpt. Missing important areas become explicit unknowns. After the
integrity gate, the author session sees the full materialized ledger—neutral
claims, exact excerpts, paths, locators, digests, confidence, and analysis—but
not the repository bundle itself.
It writes on behalf of the credited authors in first-person plural voice,
creates a problem-centered candidate, then reviews and revises that candidate
in the same conversation. That pass is self-review, not an independent model
review; an independent final evidence review is intentionally deferred.

During review, the author session emits one of two host-controlled protocol
events: `submit_draft` or `ask_questions`. `ask_questions` is not a public
deterministic CLI tool. With async feedback, Paperbot checkpoints the questions,
moves to `awaiting_author`, and later reopens the same logical author session
through `agent resume`. With sync feedback, it collects bounded terminal
answers, records their digests in the rollout, and continues without sealing
an intermediate ZIP. In auto mode, author questions are unavailable; the
author session must submit a draft and record any material working assumptions
or unresolved issues explicitly. The workflow permits at most three question rounds, two
host-directed draft repair attempts per stage, and twelve author-session
turns. Every submitted draft is checked for evidence IDs, fields, links, raw
HTML, benchmark policy, and canonical paper structure before it is accepted.
The review must ask when an author-answerable gap materially affects the
product thesis, motivation, current behavior, tradeoffs, history, benchmark
interpretation, or lessons. If review approves an unchanged draft, Paperbot
keeps the original immutable checkpoint instead of creating a duplicate
revision.

When no questions remain, or when auto mode completes its assumption-aware
review, Paperbot writes `paper.md` and ends in
`needs_author_review`. A run waiting for answers has a validated draft
checkpoint but no `paper.md` yet. Neither state submits or publishes. If a
model response or restored artifact fails validation, Paperbot fails closed
without replacing an accepted checkpoint. Run schema version 1 used the old
multi-session draft/review protocol, version 2 predates structured attribution
and release provenance, version 3 predates producer provenance, rollout
integrity, and checkpoint ZIPs, and version 4 predates explicit auto mode and
structured assumptions. Valid version-4 interactive runs are migrated in
memory and remain resumable; earlier versions are rejected.

The initial agent has no general web-search or page-fetch capability. Use
`--source <public-url>` only to provide a citeable URL; it is not fetched and
cannot establish factual claims by itself. It must be an anonymous,
query-free HTTP(S) URL, and Paperbot permits it only as a Markdown reference
link—not as evidence in the claim ledger. When related work needs external
research, Paperbot records focused author questions rather than fabricating
comparisons. The agent also omits `# Benchmarks` unless a future explicit
reproducible benchmark input is added.

### Daily GitHub Trending selection

To create a bounded research queue from today's public GitHub Trending page,
run:

```sh
bun run paperbot agent select-trending \
  --output ./paperbot-runs/trending-2026-08-04 \
  --allow-remote-model \
  --model deepseek-v4-flash \
  --format json
```

The scheduled prodxiv collector, outside Paperbot, captures and normalizes
GitHub Trending and ingests immutable observations into the prodxiv archive.
By default Paperbot requests the exact current UTC date with `period=daily`
and `language=all` from the hosted prodxiv archive at
`https://prodxiv-api.vercel.app/`. The API returns the unfiltered `any` scope
and every stored concrete language scope for that day in one response.
Paperbot requires the `any` scope and never treats it as a union or silently
returns a partial response. `--api-url` or a
non-empty `PRODXIV_API_URL` overrides the endpoint for development or
self-hosting. If today's exact snapshots are unavailable, the command fails
clearly. It never scrapes GitHub, selects a nearby date, or silently falls back
to another source.

For a reproducible or offline rerun, pass a previously saved Paperbot snapshot
bundle instead of an API URL:

```sh
bun run paperbot agent select-trending \
  --output ./paperbot-runs/trending-2026-08-03-rerun \
  --snapshot ./snapshots/trending-2026-08-03.json \
  --allow-remote-model \
  --format json
```

`--snapshot` and `--api-url` are mutually exclusive. A file input may describe
an older date. The preferred input is the schema-versioned `snapshot.json`
bundle from an earlier run. Its top-level `language` is `all` or `any`, while
each contained scope uses `any` or a concrete language slug. Every scope must
share the date and daily period, use no spoken-language filter, and contain
canonical, unique, sequentially ranked repositories. Bare unfiltered prodxiv
snapshots from earlier Paperbot runs remain accepted as single-scope inputs;
legacy `language: null` is normalized to `any` at this file boundary. Paperbot
bounds and validates either form, writes the normalized bundle with every raw
scope observation to the new run's `snapshot.json`, and only then starts Pi.

Paperbot deduplicates repositories across scopes by case-insensitive canonical
full name before starting one separate, tool-less `trend_selection` Pi session.
The first appearance in deterministic scope-and-rank order supplies shared
repository metadata. Each candidate also carries `source_appearances`, which
preserves every scope language, source rank, and per-scope `stars_in_period`;
the raw source snapshots remain intact in `snapshot.json`. The session receives
only this normalized public candidate set and scope provenance. It cannot open
repositories or browse for more context. It ranks exactly ten candidates for
potential product-paper research using distinct ideas, learning value,
inspectable implementation, and diversity as selection signals. Popularity
and appearing in multiple scopes are context, not the score. Repository names
and descriptions are treated as untrusted data, and the model-authored reason
is a research rationale rather than evidence about the repository.

The host accepts only ten unique names from the archived candidates, rejects
unknown fields and malformed reasons, and copies all repository metadata from
the snapshot rather than trusting the model to repeat it. One correction turn
is permitted in the same session. Its private Pi JSONL file lives under
`sessions/trend_selection/` even when model output is rejected. A valid run
writes schema-version `2` `selection.json` with per-scope snapshot provenance,
model metadata, the session ID, relative session artifact path and SHA-256
digest, selection `rank`, deterministic `candidate_rank`,
`source_appearances`, and reasons. `--format json` emits that same selection
artifact on stdout but never emits the session contents; diagnostics stay on
stderr. A validated `language=all` snapshot remains available if fewer than
ten unique candidates make selection impossible.

This command does not download repository contents, start paper-drafting
sessions, create a batch manifest, submit, or publish. Its ten results are a
research queue, not endorsements.

### Daily draft and canary workflows

The `Daily Paperbot Drafts` GitHub Actions workflow runs once per day and may
also be dispatched manually. It selects the first three eligible repositories
from that day's validated Trending research queue and runs them through the
normal private auto-mode `agent batch` workflow. A repository is skipped when
an existing published paper, pending draft, or approved draft names both that
repository and the current Paperbot `tool_version`; a new Paperbot version
makes it eligible again. Every successful project produces one terminal
`*_final.zip`; unsupported intention remains a visible assumption or unresolved
question rather than fabricated evidence.

The run has two ordered remote-write phases. First, it publishes drafts whose
exact current revisions were approved by an author and atomically approves and
publishes prior `pending_review` drafts that remain bot-owned. Then it submits
every successfully generated paper as a private, bot-owned `pending_review`
draft. Three remains the daily target, but one failed repository no longer
blocks the other successful drafts from reaching the review queue. An
incomplete generation or submission still makes the workflow fail after its
reports and private artifacts have been preserved.
Draft creation and publication use stable idempotency keys, so retrying a
partially completed workflow does not create duplicate papers. The Paperbot
model and drafting sessions never receive an API token and cannot submit,
approve, or publish. The host scheduler requests a short-lived GitHub Actions
OIDC token that the API maps to the bot principal; an author edit transfers
ownership and makes that draft ineligible for automatic approval.

Only five bot-owned daily drafts remain in the active `pending_review` queue.
After new submissions, the workflow marks the oldest excess pending drafts
`rejected` with a rotation reason. Rotation is auditable and retains their
content; it is not deletion. Approved drafts are outside that limit and remain
eligible for the next run unless edited.

GitHub Actions uploads the private run directories, terminal ZIPs, selection,
batch report, promotion report, submission report, and workflow metadata as
one access-controlled artifact for 30 days. The artifact can contain source
material, prompts, model output, and implementation details, so it must never
be made public.

Fixed canaries are a separate `Paperbot Fixed Canaries` workflow. They run only
when a same-repository pull request explicitly carries the
`paperbot-canaries` label, and rerun when that labeled PR changes, or when a
trusted revision is dispatched manually. The canary workflow evaluates the
three SHA-pinned repositories in
`examples/paperbot-evaluation/canaries.json`, uploads private artifacts, and
disables live GitHub release enrichment so remote release changes cannot alter
the fixed inputs. It has no publishing credential or remote publication step.
Fork pull requests must use manual dispatch after their code is trusted.

Configure `DEEPSEEK_API_KEY` once as a repository Actions secret. Both the
daily and fixed-canary workflows use that repository secret; do not duplicate
it in GitHub Environments because an environment secret with the same name
would override the repository value. Configure the daily workflow's
`production` GitHub Environment with only the `PRODXIV_API_URL` variable. The
daily workflow requests its API identity through GitHub OIDC and has no
long-lived API secret. Neither workflow needs a database credential.

### Batch public repositories

To prepare several independent research drafts, create a private JSON manifest
with one anonymous canonical GitHub repository per project:

```json
{
  "schema_version": "1",
  "github_release_policy": "best_effort",
  "projects": [
    {
      "repository_url": "https://github.com/different-ai/openwork",
      "ref": "main",
      "external_sources": ["https://github.com/different-ai/openwork"]
    },
    {
      "repository_url": "https://github.com/huggingface/speech-to-speech",
      "title": "Speech-to-Speech research draft",
      "product_name": "Speech-to-Speech"
    }
  ]
}
```

Run it directly to use per-repository owner attribution and release-based
status inference:

```sh
bun run paperbot agent batch ./projects.json \
  --output ./paperbot-runs/trending \
  --allow-remote-model \
  --mode auto \
  --model deepseek-v4-flash \
  --concurrency 2
```

Project-level `authors` and `status` override optional command defaults. When
they are absent, each project uses its GitHub owner and, when available, a
release snapshot. `github_release_policy` defaults to `best_effort`: bounded
release metadata is captured concurrently, but an oversized, unavailable, or
invalid release response is skipped without discarding the pinned repository
source. The skip reason remains in the run rollout. Set the policy to
`disabled` for deterministic canaries that must not read mutable release data.
A batch supports up to 100 repositories and
one to four concurrent runs. Batch defaults to auto mode. It creates one
isolated child directory per
repository plus an incrementally updated `batch.json` report. One project
failure does not stop other projects, but the command exits nonzero if any
project fails or its generated draft does not pass validation. With `--mode
interactive`, a project that reaches `awaiting_author` is a successful private
checkpoint; its result reports the pending question count and requires a later
individual `agent resume`. An auto batch rejects that state as a contract
violation. The batch workflow never submits or publishes.

To answer the current bounded question round and continue the same logical
author session:

```sh
bun run paperbot agent resume ./paperbot-runs/openwork \
  --answers ./answers.md \
  --allow-remote-model
```

This copies the answers into `answers/`, appends an `author_supplied` evidence
item, and either records another question round or writes another immutable
checkpoint plus `paper.md`. It leaves the editable `draft.md` intact; manual
edits are included in the resumed author context. Before sending any revision
prompt, Paperbot treats the saved run as untrusted input again: it rejects
changed session or excerpt digests, symlinks, non-UTF-8 files, sensitive paths
or markers, and source snapshots outside the original bounded limits.

## Skill catalog

Paperbot exposes its agent guidance through artifact-oriented scopes rather
than workflow phases:

- `project` covers repository discovery, observed architecture, and author
  intent;
- `paper` covers structure, references, benchmarks, and figures;
- `publication` covers readiness review and explicit submission.

The catalog follows Agent Skill progressive disclosure:

1. `paperbot skills` returns scope names and descriptions.
2. `paperbot skills <scope>` returns a concise SKILL.md-like guide that
   identifies when its components are relevant.
3. `paperbot skills <scope> <component>` returns one detailed reference.

The command also supports versioned JSON output. Scope names describe stable
objects; drafting and review are activities that may use components from more
than one scope. Agents should not load every component by default.

## Revision assistance

When a repository changes, Paperbot can compare the relevant commit range with
the latest paper and propose a revision.

A revision proposal might report:

> Authentication was added, the storage architecture changed, and two
> documented limitations may no longer apply.

The proposal should identify affected sections and preserve all existing author
edits. The author decides whether the changes justify a new published revision.

## Safety and trust boundaries

Paperbot must:

- Never give publication credentials to a model or drafting session.
- Never automatically approve an author-owned or human-edited draft. The host
  scheduler may approve and publish only an unchanged bot-owned draft from a
  previous run.
- Never invent benchmark results or experimental methodology.
- Never treat README marketing statements as established facts.
- Never include secrets, credentials, environment files, user data, or other
  sensitive material in a draft.
- Exclude generated code, vendored dependencies, and irrelevant large assets
  by default.
- Show which files were selected for analysis.
- Preserve author edits when revising individual sections.
- Keep uncertainty visible during drafting.

The `publish` command is deliberately separate from drafting. It validates the
submission, displays its destination and source hash, and requires an
interactive confirmation or an explicit `--yes`. Agents must never infer that
drafting approval also authorizes publication.

Local publishing credentials live in `~/.tokn/prodxiv/auth.toml` with
owner-only permissions. The file may include the publishing API URL and public
site URL so successful publication output can link to both the API record and
the human-readable paper. Environment variables are supported for CI. The
token is temporary MVP authorization and must never be included in paper
content, diagnostics, or command output. `paperbot auth` creates a commented
credential template when the file does not exist. Publishing never creates or
changes the credential file.

Private and unpublished code introduces additional trust requirements. Local
analysis is the default so repository contents do not need to be uploaded. If
remote analysis is supported later, retention, access, deletion, and
model-training policies must be explicit.

## Initial scope

The first version should support:

- Local repositories through a CLI or agent-assisted workflow.
- Markdown documentation.
- Repository structure, dependency, test, and benchmark detection.
- A section-complete Markdown scaffold.
- An optional Benchmarks section only when reproducible methodology or results
  exist.
- Agent-assisted drafting and a focused author interview.
- Structural validation and private preview.
- Manual approval for author-owned submission; clearly attributed scheduled
  release for unchanged bot-owned evaluation drafts.

Private repository integrations can follow once authentication, data retention,
and user trust are designed deliberately. Issue trackers, chats, analytics, and
design tools are not required to validate the core drafting experience.

## Success criteria

Paperbot succeeds when it:

- Produces a useful draft faster than an author can start from a blank page.
- Makes incomplete or unsupported statements easier to notice.
- Asks questions that improve the paper rather than merely filling sections.
- Describes observed product behavior without inventing product intent.
- Helps authors keep papers current without erasing historical revisions.
- Leaves authors feeling that the paper is theirs.
