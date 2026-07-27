# Paperbot

Paperbot is a local-first Bun CLI that turns repository evidence into a product
paper draft. The initial command is a deterministic repository scan:

```sh
bun run paperbot scan .
bun run paperbot scan . --format json
bun run paperbot scan . --include .env.example
```

The human-readable format summarizes the scan. JSON output conforms to
`schemas/evidence.schema.json` and contains an empty claim list; drafting is a
separate, agent-guided step.

The scanner requires a Git worktree. It uses Git's file index so `.gitignore`
and global ignore rules are respected. Sensitive, generated, vendored, binary,
and oversized files are excluded even when they are tracked. Additional
exclusions can be supplied with repeatable `--exclude <glob>` options.
Tracked files that match a default path exclusion can be opted in with a
repeatable `--include <glob>`. Explicit exclusions, Git ignore rules, generated
content, binary files, symlinks, and size limits still take precedence.

## Exit codes

- `0` — success
- `2` — invalid command-line usage
- `3` — the target is not a readable Git repository
- `4` — scanning failed
