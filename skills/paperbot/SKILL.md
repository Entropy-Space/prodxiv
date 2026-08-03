---
name: paperbot
description: Turn an existing repository and its documentation into a prodxiv product paper draft, validate it, and publish it after explicit author approval. Use when an agent needs to scan a codebase, draft or improve a Markdown product paper, interview an author about intent and tradeoffs, review uncertain statements, validate a draft, or submit an approved paper with the Paperbot CLI.
---

# Paperbot

Use the deterministic Paperbot CLI for repository selection, scaffolding, and
validation. Use agent judgment for source reading, author questions, and prose.

Read [references/drafting-guidance.md](references/drafting-guidance.md) before
writing or revising a paper.

## Resolve the CLI

Choose one command and use it consistently:

1. Use `bun run paperbot` at the prodxiv workspace root.
2. Otherwise, use a `paperbot` executable already available on `PATH`.

The workflow below calls the selected command `PAPERBOT_CMD`; substitute the
selected command rather than typing that label literally.

Do not install dependencies, send repository contents to a remote service, or
make remote writes unless the user explicitly requests it.

For machine-facing integrations, discover the deterministic interface with
`PAPERBOT_CMD tools list` and `PAPERBOT_CMD tools describe <tool>`. Invoke the
direct commands with normal CLI arguments, for example:

```sh
PAPERBOT_CMD tools repo_scan . --format json
PAPERBOT_CMD tools paper_scaffold scan.json
PAPERBOT_CMD tools paper_validate paper.md --format json
```

JSON is an output format, not a request envelope. These tools do not include
authentication or publication. The model itself must not obtain shell access
or call the CLI directly; the host controls which bounded tool commands and
arguments are supplied.

## Use the optional Pi agent

Use `PAPERBOT_CMD agent` only when the user explicitly authorizes remote model
analysis. It is a private drafting workflow, never a publication workflow.

Prefer the configured local model router when available:

```sh
export PAPERBOT_MODEL_BASE_URL=http://127.0.0.1:4141/v1
```

If that gateway enables client authentication, set one of
`PAPERBOT_MODEL_API_KEY` or `TOKN_API_KEY` through the user's normal secret
management mechanism. If it does not, use no Paperbot API key and do not
invent a placeholder secret. The router owns any upstream-provider credential.
Paperbot accepts only anonymous loopback HTTP(S) values for this endpoint.
Alternatively, direct DeepSeek remains supported with `DEEPSEEK_API_KEY` when
no local router is configured. Never put any key in a command argument,
manifest, paper, or run artifact.

For a public GitHub repository, require the author to provide their paper
identity and a product status rather than inferring either from contributors or
marketing copy:

```sh
PAPERBOT_CMD agent run https://github.com/owner/repository \
  --output ./paperbot-runs/repository \
  --author "Paper author" \
  --status public_beta \
  --allow-remote-model
```

`--allow-remote-model` is explicit consent to send the bounded selected source
bundle to the configured model, including through a loopback router that may
route it onward. The agent accepts a local Git worktree or an anonymous
canonical public GitHub URL. For GitHub it resolves an exact source revision
without cloning or executing repository code. It has no shell, filesystem,
browser, credential, or publish tools.

The run ends with private artifacts including `draft.md`, `evidence.jsonl`,
`questions.md`, `review.json`, and `validation.json`. It always stops at
author review. Do not use `publish` unless the author separately and explicitly
approves the exact reviewed paper.

Use `PAPERBOT_CMD agent resume <run-directory> --answers <answers.md>
--allow-remote-model` to create a numbered proposal from author answers. It
preserves `draft.md`; the author decides whether to incorporate the proposal.

For multiple public repositories, use a private versioned JSON manifest and
the batch command:

```sh
PAPERBOT_CMD agent batch ./projects.json \
  --output ./paperbot-runs/trending \
  --author "Paper research team" \
  --status public_beta \
  --allow-remote-model \
  --concurrency 2
```

Each manifest project must provide an anonymous canonical
`https://github.com/<owner>/<repo>` URL. It may override `authors`, `status`,
title, product metadata, revision, and reference-only `external_sources`.
Command-level authors and status are defaults, never inferred values. Paperbot
writes a private child run for each project and `batch.json`; one failed
project does not stop the remainder, but a failed or invalid draft makes the
batch exit nonzero. Do not place API keys, signed URLs, or source contents in
the manifest.

## Load guidance progressively

Run `PAPERBOT_CMD skills` to discover artifact scopes. Load the relevant
SKILL.md-like scope guide before loading any detailed component:

- [Project](references/project-skill.md) for repository evidence,
  architecture, and author intent.
- [Paper](references/paper-skill.md) for structure, references, benchmarks,
  and figures.
- [Publication](references/publication-skill.md) for readiness and explicit
  submission.

Run `PAPERBOT_CMD skills <scope>` to load the scope guide. Follow its
instructions to load a detailed component with
`PAPERBOT_CMD skills <scope> <component>` only when the current task needs it.
Do not load every component by default. Treat guidance as procedure, not as
authorization for remote writes.

## Build a draft

1. Confirm the repository root, paper output path, and any additional
   exclusions. Respect `.gitignore` and Paperbot's safe defaults.
2. Run `PAPERBOT_CMD scan <repository> --format json`. Capture stdout alone in
   a private `scan.json`; keep stderr as diagnostics.
3. Review the selected file inventory. Stop and tell the user if sensitive,
   irrelevant, generated, or vendored files appear.
4. Run `PAPERBOT_CMD draft <scan.json> --output <paper.md>`, adding `--title`
   when the title is known.
5. Read the most relevant selected files and record which repository evidence
   supports each material claim. Do not copy repository secrets or private
   user data into the paper.
6. Research the specific products, websites, repositories, documentation, and
   papers needed for Background and Related Work. Prefer primary sources and
   do not send private repository contents, paths, or implementation details
   to a search service.
7. Cite external claims near the relevant prose and add complete Markdown
   links to References. Distinguish repository evidence, external sources,
   author statements, and agent inference during review.
8. Ask focused questions for motivation, history, rejected alternatives,
   tradeoffs, lessons, and benchmark context that the available evidence
   cannot explain.
9. Incorporate answers while preserving the author's wording and manual edits
   where practical. Add a Benchmarks section only when reproducible
   methodology or results exist.
10. Run `PAPERBOT_CMD validate <paper.md> --profile draft --format json`.
    Resolve every error and explain any warnings that remain.

Treat a nonzero CLI exit as a failed step. Do not continue from invalid or
partial JSON output.

## Revise an existing paper

Preserve manual edits. Rescan the intended revision, compare the selected files
and repository changes, and update only affected sections. Keep limitations and
contradictory information visible until the author resolves them.

Do not overwrite an existing paper with `paperbot draft`. Edit it in place
after reviewing the diff.

## Publish an approved paper

Publication is a remote write and creates an immutable paper revision. Never
infer publication approval from a request to scan, draft, revise, or validate.

After the author explicitly asks to publish:

1. Run `PAPERBOT_CMD validate <paper.md> --profile submission --format json`.
2. Resolve every error and show warnings to the author.
3. Confirm the exact paper path and destination shown by Paperbot.
4. Run `PAPERBOT_CMD publish <paper.md> --yes --format json`. Add
   `--product-id <id>` when the paper is about an existing product.
5. Report the allocated `paper_id`, version, API location, optional web URL,
   and whether an existing publication was recovered from an idempotent retry.

Do not read, display, or copy the token from
`~/.tokn/prodxiv/auth.toml`. If authentication is missing, ask the author to
run `PAPERBOT_CMD auth` to create the commented template or
`PAPERBOT_CMD auth set --api-url <url> [--site-url <url>]` to configure it
directly. Publishing does not initialize credentials. Never pass a token as a
command-line argument.

## Finish

Report:

- paper and private scan manifest paths;
- repository revision and dirty-state recorded by the scan;
- validation status;
- material claims that still lack an inspectable source;
- unresolved author questions and incomplete sections.

Without explicit author confirmation, stop after validation and never run
`publish`.
