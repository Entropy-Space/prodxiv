# Paperbot

Paperbot is a local-first Bun CLI that turns repository evidence into a product
paper draft. The initial command is a deterministic repository scan:

```sh
bun run paperbot scan .
bun run paperbot scan . --format json
bun run paperbot scan . --include .env.example
bun run paperbot draft evidence.json --output paper.md
bun run paperbot validate paper.md
bun run paperbot validate paper.md --profile publication --format json
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

`validate` checks YAML front matter, the canonical paper schema, required
Markdown sections, draft or publication requirements, and a referenced
evidence bundle. It returns a versioned diagnostic report in JSON mode. Local
validation is a fast authoring check; the publishing API will validate again
using the authoritative Rust domain.

`draft` accepts a valid evidence bundle and creates a section-complete Markdown
scaffold. It does not turn repository observations into prose or copy claims
into the paper. Missing author metadata and narrative content remain visibly
incomplete for the Agent Skill and author to resolve. Without `--output`, the
scaffold is written to stdout. With `--output`, Paperbot creates a new file and
refuses to overwrite an existing draft.

## Exit codes

- `0` — success
- `2` — invalid command-line usage
- `3` — the target is not a readable Git repository
- `4` — reading or scanning failed
- `5` — validation completed and found errors
