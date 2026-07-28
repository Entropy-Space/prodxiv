---
name: paperbot-paper
description: Author or revise an evidence-backed prodxiv paper. Use when an agent needs the paper structure, related-work research and references, benchmark policy, or safe inline SVG figure guidance.
---

# Paperbot paper

Write durable product knowledge rather than launch-page promotion. Preserve
uncertainty and deliberate author edits.

Use `bun run paperbot` at the prodxiv workspace root or a `paperbot`
executable on `PATH` as `PAPERBOT_CMD`.

## Workflow

1. Establish the paper structure and evidence available for each material
   claim.
2. Research and cite related work without disclosing private project details.
3. Include benchmarks or figures only when their evidence requirements are
   satisfied.
4. Validate the resulting Markdown and surface unresolved questions.

## Load focused guidance

- Run `PAPERBOT_CMD skills paper structure` when assembling or revising the
  complete paper.
- Run `PAPERBOT_CMD skills paper references` for external research, Related
  Work, and citations.
- Run `PAPERBOT_CMD skills paper benchmarks` only when measurements or
  performance claims are involved.
- Run `PAPERBOT_CMD skills paper figures` only when a workflow, architecture
  boundary, comparison, or measured result benefits from a visual.

Load only the components required by the current task. Do not add content
merely because guidance for it exists.
