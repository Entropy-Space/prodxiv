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

## Build a draft

1. Confirm the repository root, paper output path, and any additional
   exclusions. Respect `.gitignore` and Paperbot's safe defaults.
2. Run `PAPERBOT_CMD scan <repository> --format json`. Capture stdout alone in
   a private `scan.json`; keep stderr as diagnostics.
3. Review the selected file inventory. Stop and tell the user if sensitive,
   irrelevant, generated, or vendored files appear.
4. Run `PAPERBOT_CMD draft <scan.json> --output <paper.md>`, adding `--title`
   when the title is known.
5. Read the most relevant selected files and complete sections conservatively.
   Do not copy repository secrets or private user data into the paper.
6. Ask focused questions for motivation, history, rejected alternatives,
   tradeoffs, lessons, and benchmark context that the repository cannot
   explain.
7. Incorporate answers while preserving the author's wording and manual edits
   where practical.
8. Run `PAPERBOT_CMD validate <paper.md> --profile draft --format json`.
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

Publication is a remote write and creates an immutable paper version. Never
infer publication approval from a request to scan, draft, revise, or validate.

After the author explicitly asks to publish:

1. Run `PAPERBOT_CMD validate <paper.md> --profile submission --format json`.
2. Resolve every error and show warnings to the author.
3. Confirm the exact paper path and destination shown by Paperbot.
4. Run `PAPERBOT_CMD publish <paper.md> --yes --format json`.
5. Report the allocated `paper_id`, version, location, and whether an existing
   publication was recovered from an idempotent retry.

Do not read, display, or copy the token from
`~/.tokn/prodxiv/auth.toml`. If authentication is missing, ask the author to
run `PAPERBOT_CMD auth set --api-url <url>` themselves. Never pass a token as a
command-line argument.

## Finish

Report:

- paper and private scan manifest paths;
- repository revision and dirty-state recorded by the scan;
- validation status;
- unresolved author questions and incomplete sections.

Without explicit author confirmation, stop after validation and never run
`publish`.
