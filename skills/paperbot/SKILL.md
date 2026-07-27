---
name: paperbot
description: Turn an existing repository and its documentation into an evidence-backed prodxiv product paper. Use when an agent needs to scan a codebase, draft or improve a Markdown product paper, trace product claims to source files, identify unsupported claims, interview an author about intent and tradeoffs, or validate a draft with the Paperbot CLI.
---

# Paperbot

Use the deterministic Paperbot CLI for scanning, scaffolding, and validation.
Use agent judgment only for evidence review, author questions, and prose.

Read [references/drafting-policy.md](references/drafting-policy.md) before
writing or revising claims.

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
2. Run `PAPERBOT_CMD scan <repository> --format json`. Capture stdout alone in an
   evidence JSON file; keep stderr as diagnostics.
3. Review the indexed source list before drafting. Stop and tell the user if
   sensitive, irrelevant, generated, or vendored files appear.
4. Run `PAPERBOT_CMD draft <evidence.json> --output <paper.md>`, adding `--title`
   when the title is known.
5. Read the most relevant indexed sources. Add claim records to the evidence
   bundle as described in the drafting policy, then write only supported prose.
6. Ask focused questions for motivation, history, rejected alternatives,
   tradeoffs, lessons, and any benchmark context that the repository cannot
   establish.
7. Incorporate answers as `author_provided`; preserve visible uncertainty and
   the author's wording where practical.
8. Run `PAPERBOT_CMD validate <paper.md> --profile draft --format json`. Resolve
   every error and explain any warnings that remain.

Treat a nonzero CLI exit as a failed step. Do not continue from invalid or
partial JSON output.

## Revise an existing paper

Preserve manual edits and existing claim identifiers. Rescan the intended
revision, compare source hashes and relevant files, and change only affected
claims and sections. Mark stale claims as unresolved instead of silently
removing limitations or contradictory evidence.

Do not overwrite an existing paper with `paperbot draft`. Edit it in place
after reviewing the diff.

## Finish

Report:

- paper and evidence bundle paths;
- repository revision and dirty-state recorded by the scan;
- verified, inferred, author-provided, and missing-evidence claim counts;
- validation status and unresolved author questions.

Never submit or publish a paper. Publication is a separate operation requiring
explicit author confirmation.
