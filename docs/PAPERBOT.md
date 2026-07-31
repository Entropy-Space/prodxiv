# Paperbot

## Purpose

Paperbot turns an existing codebase and its documentation into an initial
product paper draft.

It is a research assistant for authors, not an autonomous publisher. Its role
is to reduce the work required to create a thoughtful first draft while
preserving author control and the credibility of prodxiv.

The guiding rule is:

> Infer implementation. Ask about intention.

Code can reveal architecture, dependencies, features, tests, releases, and
sometimes performance characteristics. It cannot reliably explain why a
product exists, why alternatives were rejected, or what its creators learned.
Paperbot should describe what it can observe and turn missing context into
specific author questions.

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
4. **Understand the project.** The drafting agent reads relevant files and
   detects languages, architecture, dependencies, tests, releases, and
   benchmark suites.
5. **Research related work.** The agent identifies specific products,
   websites, repositories, documentation, and papers, verifies claims against
   inspectable sources, and records public citations without disclosing private
   repository contents.
6. **Generate a private draft.** The agent completes sections supported by
   repository evidence, external sources, or author statements and leaves
   uncertain details as questions.
7. **Interview the author.** It asks a short, adaptive set of questions about
   motivation, background, alternatives, tradeoffs, and lessons.
8. **Revise collaboratively.** Author answers are incorporated without
   overwriting deliberate manual edits.
9. **Review and approve.** The author reviews privacy, accuracy, and
   completeness before any submission.
10. **Publish explicitly.** After approval, the CLI submits the exact reviewed
    Markdown to the authoritative API and reports its allocated identifier.

## Example draft behavior

```markdown
# Motivation

> Author input required:
> What user problem originally motivated this project?
> Why were existing tools insufficient?

# Core Features

## Local-first persistence

The repository implements local workspace storage and asynchronous
synchronization.

> Author review:
> Is offline operation a product goal or only an implementation detail?

# Limitations

No reproducible benchmark results were found, so this draft omits a
Benchmarks section. It does not make performance claims.
```

Paperbot should never turn missing context into polished but unsupported prose.

## Pi agent workflow

`paperbot agent` is an optional, local-orchestrated drafting workflow. It uses
the Pi SDK with `deepseek-v4-flash` by default, but it is deliberately separate
from deterministic commands such as `scan`, `draft`, `validate`, and `publish`.
Those commands do not require a model key or start Pi.

Set `DEEPSEEK_API_KEY` in the environment through the user's normal secret
management mechanism. Never place it in a command argument, batch manifest,
paper, or run artifact. Then create a private draft from a local Git worktree
or an anonymous canonical public GitHub repository URL:

```sh
bun run paperbot agent run https://github.com/different-ai/openwork \
  --output ./paperbot-runs/openwork \
  --author "prodxiv research" \
  --status public_beta \
  --allow-remote-model \
  --model deepseek-v4-flash
```

`--author` identifies the paper author, not a repository contributor. Paperbot
will not infer authorship from GitHub. `--status` is also deliberate author
metadata: code and a repository URL do not reliably establish a product's
release status.

`--allow-remote-model` is required even for a public source. It confirms that
the bounded selected source bundle may be sent to the configured model. The
agent never reads Paperbot publishing credentials and has no publication
capability.

For a remote source, Paperbot accepts only
`https://github.com/<owner>/<repo>` (optionally ending in `.git`). It resolves
the requested or default ref to an exact commit SHA through GitHub, rejects
private repositories, symlinks, submodules, unsafe paths, truncated trees, and
oversized content, then verifies each raw file against its Git blob SHA before
reading a small SHA-pinned UTF-8 source bundle. It does not clone the
repository, run its code, install dependencies, or fetch
arbitrary URLs.

Pi runs with an in-memory credential store and session, with built-in tools,
extensions, skills, prompt templates, themes, and repository context-file
discovery disabled. The model receives a host-built source bundle; it cannot
use a shell, read arbitrary files, browse the web, access environment
variables, or call `publish`.

The agent writes a new private run directory with:

- `run.json` — state, requested model, source revision, artifact paths, and
  draft SHA-256;
- `source.json`, `scan.json`, and `source/` — the bounded private source
  snapshot and original scan inventory;
- `evidence.jsonl` — claim-level repository, author, or inference
  provenance; supplied external URLs remain reference-only until their
  contents are explicitly snapshotted;
- `draft.md`, `questions.md`, `review.json`, and `validation.json` — the draft,
  unresolved author questions, independent review, and deterministic report.

The model first drafts, then a fresh Pi session reviews the draft, and Paperbot
allows one repair pass for structural or evidence-review errors. The workflow
ends in `needs_author_review` even when draft validation passes. It never
submits or publishes.

The initial agent has no general web-search or page-fetch capability. Use
`--source <public-url>` only to provide a citeable URL; it is not fetched and
cannot establish factual claims by itself. It must be an anonymous,
query-free HTTP(S) URL, and Paperbot permits it only as a Markdown reference
link—not as evidence in the claim ledger. When related work needs external
research, Paperbot records focused author questions rather than fabricating
comparisons. The agent also omits `# Benchmarks` unless a future explicit
reproducible benchmark input is added.

### Batch public repositories

To prepare several independent research drafts, create a private JSON manifest
with one anonymous canonical GitHub repository per project:

```json
{
  "schema_version": "1",
  "projects": [
    {
      "repository_url": "https://github.com/different-ai/openwork",
      "ref": "main",
      "external_sources": ["https://github.com/different-ai/openwork"]
    },
    {
      "repository_url": "https://github.com/huggingface/speech-to-speech",
      "title": "Speech-to-Speech research draft",
      "product_name": "Speech-to-Speech",
      "authors": ["prodxiv research"],
      "status": "public_beta"
    }
  ]
}
```

Run it with explicit batch defaults when each project does not set its own
paper author or product status:

```sh
bun run paperbot agent batch ./projects.json \
  --output ./paperbot-runs/trending \
  --author "prodxiv research" \
  --status public_beta \
  --allow-remote-model \
  --model deepseek-v4-flash \
  --concurrency 2
```

Project-level `authors` and `status` override command defaults; Paperbot
never fills either in from GitHub. A batch supports up to 100 repositories and
one to four concurrent runs. It creates one isolated child directory per
repository plus an incrementally updated `batch.json` report. One project
failure does not stop other projects, but the command exits nonzero if any
project fails or its generated draft does not pass validation. The batch
workflow never submits or publishes.

To incorporate author answers, create a proposal rather than overwriting the
reviewed draft:

```sh
bun run paperbot agent resume ./paperbot-runs/openwork \
  --answers ./answers.md \
  --allow-remote-model
```

This leaves `draft.md` intact and writes the next `proposal-<n>.md` with its
own validation report. The author compares it with their draft and decides
what to adopt. Before sending any revision prompt, Paperbot treats the saved
run as untrusted input again: it rejects changed digests, symlinks,
non-UTF-8 files, sensitive paths or markers, and source snapshots outside
the original bounded limits.

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

- Never publish automatically.
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
- Manual approval before submission.

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
