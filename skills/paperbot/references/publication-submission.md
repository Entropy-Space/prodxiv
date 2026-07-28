# Publication submission

Use this component only after explicit author approval.

1. Let Paperbot resolve credentials without reading or displaying the token.
2. Review the title, target, input path, and source SHA-256 shown by Paperbot.
3. Run `PAPERBOT_CMD publish <paper.md> --yes --format json`.
4. Report the allocated `paper_id`, version, API location, optional reader URL,
   source hash, and whether an idempotent retry recovered an existing result.

Publishing creates an immutable remote version. Never infer approval, publish
automatically, pass a token on the command line, or modify credentials during
submission.
