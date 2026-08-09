# Paperbot

Paperbot is a local-first Bun CLI that turns an existing repository into an
initial product paper draft:

```sh
bun run paperbot tools repo_scan .
bun run paperbot tools repo_scan . --format json
bun run paperbot tools repo_scan . --include .env.example --format json
bun run paperbot tools paper_scaffold scan.json > paper.md
bun run paperbot tools paper_validate paper.md
bun run paperbot tools paper_validate paper.md --profile publication --format json
bun run paperbot skills
bun run paperbot skills paper
bun run paperbot skills paper references
bun run paperbot skills publication readiness --format json
bun run paperbot tools list
bun run paperbot tools describe paper_validate
bun run paperbot tools repo_scan . --format json > scan.json
bun run paperbot tools paper_scaffold scan.json > paper.md
bun run paperbot tools paper_validate paper.md --format json
bun run paperbot agent select-trending \
  --output ./paperbot-runs/trending-2026-08-04 \
  --allow-remote-model \
  --format json
bun run paperbot agent run https://github.com/tigerbeetle/tigerbeetle \
  --output ./paperbot-runs/tigerbeetle \
  --allow-remote-model
bun run paperbot auth
bun run paperbot auth set \
  --api-url https://api.prodxiv.example \
  --site-url https://prodxiv.example
bun run paperbot publish paper.md
```

The human-readable format summarizes the scan. JSON output is a versioned,
private manifest containing repository metadata and the selected file
inventory. Scaffolding and validation are separate deterministic tool steps.

`skills` exposes focused agent guidance through stable artifact scopes:
`project`, `paper`, and `publication`. It follows Agent Skill progressive
disclosure: `paperbot skills` returns scope metadata,
`paperbot skills <scope>` returns a concise SKILL.md-like guide, and
`paperbot skills <scope> <component>` returns one detailed reference only when
needed. JSON output is versioned for agent integrations. The guidance is
bundled from the portable Paperbot Agent Skill so the CLI and installed skill
share one source.

`repo_scan` requires a Git worktree. It uses Git's file index so `.gitignore`
and global ignore rules are respected. Sensitive, generated, vendored, binary,
and oversized files are excluded even when they are tracked. Additional
exclusions can be supplied with repeatable `--exclude <glob>` options.
Tracked files that match a default path exclusion can be opted in with a
repeatable `--include <glob>`. Explicit exclusions, Git ignore rules, generated
content, binary files, symlinks, and size limits still take precedence.

`paper_validate` checks YAML front matter, the canonical paper schema, required
Markdown sections, and draft or publication requirements. It returns a
versioned diagnostic report in JSON mode. Local validation is a fast authoring
check; the publishing API will validate again using the authoritative Rust
domain.

`tools` is the strict interface for deterministic operations that an agent host
or automation may call. `tools list` and `tools describe <tool>` expose the
versioned catalog. The direct tool commands use normal CLI arguments; JSON is
an output format, never a tool input envelope. `repo_scan --format json` emits
the canonical scan manifest, `paper_scaffold` emits Markdown by default or a
JSON report-plus-Markdown result, and `paper_validate --format json` emits the
validation report. Tool commands do not publish, authenticate, write files,
access the network, or execute shell commands. `skills`, `agent`, `auth`, and
`publish` remain separate command families with different responsibilities.

`paper_scaffold` accepts a valid scan manifest and emits a section-complete
Markdown scaffold to stdout. It does not turn repository observations into
prose, and it never writes or overwrites a paper file. Missing author and
writer metadata, along with narrative content, remain visibly incomplete for
the Agent Skill and author to resolve.

`agent run` is the optional model-assisted workflow. It creates one isolated
Pi evidence session, verifies exact repository excerpts and snapshotted
release-note excerpts into `evidence.jsonl`, then creates one separate author
session that drafts and self-reviews from that validated ledger. Public GitHub
runs use a bounded, coverage-aware file selection across architecture, core
implementation, interfaces, verification, performance, and operations when
available. The evidence prompt favors product-defining claims over incidental
constants and file trivia and records them in neutral product-name language.
The author session writes on behalf of the credited product authors using
first-person plural voice, organizes the draft around the product problem, and
does not invent intention merely to make `we` prose sound complete. It can emit a bounded
`ask_questions` event;
the host checkpoints it as `awaiting_author`, and `agent resume --answers`
reopens the same logical author session. Once the loop completes, Paperbot
writes `paper.md` and stops at `needs_author_review`. It never publishes, and
independent final evidence review is not part of this version. Both sessions
are retained as Pi-native JSONL under the private run directory; `run.json`
records their relative paths, IDs, and SHA-256 digests.
An unchanged self-review approves the existing draft checkpoint without
creating a duplicate immutable revision.

For a public GitHub URL, `agent run` uses the repository owner as the default
organization author and never derives authors from commits or contributors. It
snapshots up to ten releases and bounded release notes: stable release evidence
supports `launched`, prerelease evidence supports `public_beta`, and no
supported release produces an explicit `unknown` status. `--author` and
`--status` remain explicit overrides. Local runs do not contact GitHub. Every
generated paper credits `paperbot` and the selected model as its agent writer;
agent-only papers omit the optional human-writer `communication_email`.

`agent select-trending` is a separate bounded research workflow. By default it
requests the exact UTC date with `period=daily&language=all` from the hosted
prodxiv archive at `https://prodxiv-api.vercel.app/`. One response contains the
unfiltered `any` scope plus every stored concrete language scope for that day.
`--api-url` or a non-empty `PRODXIV_API_URL`
overrides that endpoint for development or self-hosting. It never scrapes
GitHub, accepts an aggregate response without the `any` scope, or falls back to
a different source. `--snapshot <snapshot.json>` uses a previously saved Paperbot
`language=all` bundle instead, including an older date for an offline
reproducible run; bare legacy unfiltered prodxiv snapshots remain accepted as
single-scope inputs and normalize `language: null` to `any` at the file boundary.
Paperbot writes every normalized source scope to `snapshot.json`, deduplicates
repositories by canonical full name for the tool-less Pi session, and retains
each candidate's deterministic `candidate_rank` plus all `source_appearances`
with scope language and source rank. The host requires exactly ten unique
candidates and writes the model's selection order as `rank` in versioned
schema-version `2` `selection.json`. The private Pi-native JSONL remains under
`sessions/trend_selection/`, while the selection records its relative path and
SHA-256 digest. `--format json` emits the selection object on stdout, never the
session contents. The model cannot browse repositories, and the command does
not draft or publish papers. The selection is a research queue, not an
endorsement.

Every Paperbot-started Pi session file is created before its first model turn,
is mode `0600` inside a mode-`0700` run directory, and stays local. Session
JSONL contains full prompts, model replies, and usage metadata, so treat the
entire run directory as private. Paperbot never includes session files in a
submission or publication.

`auth` creates a commented credential template if it does not exist and never
overwrites it. `auth set` stores the API URL, optional public site URL, and
publishing token in
`~/.tokn/prodxiv/auth.toml`. Paperbot creates the directory with mode `0700`
and the file with mode `0600`; it refuses to read a credential file accessible
by other users. The token is entered through a hidden prompt by default. Use
`--token-stdin` for a pipe, never a command-line token argument. For CI,
`PRODXIV_API_URL`, `PRODXIV_SITE_URL`, and `PRODXIV_PUBLISH_TOKEN` override the
file.

`publish` validates with the submission profile, shows the destination and
exact source hash, and asks for confirmation before making a remote write.
`--yes` is the explicit non-interactive confirmation for agents and CI. A
deterministic idempotency key derived from the exact Markdown lets the command
safely recover the original publication after a timeout instead of creating a
duplicate. It never creates or changes the credential file; run `paperbot auth`
first to bootstrap the template. When a site URL is configured, successful
output includes the exact human-readable paper URL.

## Exit codes

- `0` — success
- `2` — invalid command-line usage
- `3` — the target is not a readable Git repository
- `4` — reading or scanning failed
- `5` — validation completed and found errors
- `6` — authentication is absent or invalid
- `7` — a required remote API could not be reached
- `8` — a remote API or model workflow failed
