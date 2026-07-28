---
name: paperbot-project
description: Understand an authorized product project from repository evidence and targeted author input. Use when an agent needs to discover the product surface, explain observed architecture, or ask about intent that implementation cannot prove.
---

# Paperbot project

Build an evidence map before writing product claims. Infer implementation and
ask the author about intention.

Use `bun run paperbot` at the prodxiv workspace root or a `paperbot`
executable on `PATH` as `PAPERBOT_CMD`.

## Workflow

1. Scan and review the authorized repository scope.
2. Identify the product surface and relevant evidence.
3. Explain important architecture only when the paper needs it.
4. Ask targeted questions for motivation, tradeoffs, and lessons.

## Load focused guidance

- Run `PAPERBOT_CMD skills project discovery` when selecting and mapping
  repository evidence.
- Run `PAPERBOT_CMD skills project architecture` when tracing boundaries or
  flows.
- Run `PAPERBOT_CMD skills project intent` when repository contents cannot
  establish why a decision was made.

Load only the components required by the current task. Keep repository
observations, author statements, and agent inferences distinct.
