---
name: paperbot-publication
description: Prepare and explicitly submit an approved prodxiv paper version. Use when an agent needs to perform publication-readiness checks or submit the exact reviewed Markdown as an immutable remote version.
---

# Paperbot publication

Treat publication as an explicit, immutable remote write. Approval to draft,
revise, or validate is not approval to publish.

Use `bun run paperbot` at the prodxiv workspace root or a `paperbot`
executable on `PATH` as `PAPERBOT_CMD`.

## Workflow

1. Review the exact Markdown, destination, evidence, privacy, and validation
   result.
2. Resolve errors and show remaining warnings to the author.
3. Obtain explicit approval for the exact source.
4. Submit without exposing or changing credentials.

## Load focused guidance

- Run `PAPERBOT_CMD skills publication readiness` before requesting final
  approval.
- Run `PAPERBOT_CMD skills publication submission` only after explicit
  approval.

Load readiness guidance before submission guidance. Never infer publication
authorization from earlier authoring work.
