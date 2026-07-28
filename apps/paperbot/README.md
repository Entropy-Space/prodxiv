# Paperbot

Paperbot is a local-first Bun CLI that turns an existing repository into an
initial product paper draft:

```sh
bun run paperbot scan .
bun run paperbot scan . --format json
bun run paperbot scan . --include .env.example
bun run paperbot draft scan.json --output paper.md
bun run paperbot validate paper.md
bun run paperbot validate paper.md --profile publication --format json
bun run paperbot auth
bun run paperbot auth set --api-url https://api.prodxiv.example
bun run paperbot publish paper.md
```

The human-readable format summarizes the scan. JSON output is a versioned,
private manifest containing repository metadata and the selected file
inventory. Drafting is a separate, agent-guided step.

The scanner requires a Git worktree. It uses Git's file index so `.gitignore`
and global ignore rules are respected. Sensitive, generated, vendored, binary,
and oversized files are excluded even when they are tracked. Additional
exclusions can be supplied with repeatable `--exclude <glob>` options.
Tracked files that match a default path exclusion can be opted in with a
repeatable `--include <glob>`. Explicit exclusions, Git ignore rules, generated
content, binary files, symlinks, and size limits still take precedence.

`validate` checks YAML front matter, the canonical paper schema, required
Markdown sections, and draft or publication requirements. It returns a
versioned diagnostic report in JSON mode. Local validation is a fast authoring
check; the publishing API will validate again using the authoritative Rust
domain.

`draft` accepts a valid scan manifest and creates a section-complete Markdown
scaffold. It does not turn repository observations into prose. Missing author
metadata and narrative content remain visibly incomplete for the Agent Skill
and author to resolve. Without `--output`, the scaffold is written to stdout.
With `--output`, Paperbot creates a new file and refuses to overwrite an
existing draft.

`auth` creates a commented credential template if it does not exist and never
overwrites it. `auth set` stores the API URL and publishing token in
`~/.tokn/prodxiv/auth.toml`. Paperbot creates the directory with mode `0700`
and the file with mode `0600`; it refuses to read a credential file accessible
by other users. The token is entered through a hidden prompt by default. Use
`--token-stdin` for a pipe, never a command-line token argument. For CI,
`PRODXIV_API_URL` and `PRODXIV_PUBLISH_TOKEN` override the file.

`publish` validates with the submission profile, shows the destination and
exact source hash, and asks for confirmation before making a remote write.
`--yes` is the explicit non-interactive confirmation for agents and CI. A
deterministic idempotency key derived from the exact Markdown lets the command
safely recover the original publication after a timeout instead of creating a
duplicate. It never creates or changes the credential file; run `paperbot auth`
first to bootstrap the template.

## Exit codes

- `0` — success
- `2` — invalid command-line usage
- `3` — the target is not a readable Git repository
- `4` — reading or scanning failed
- `5` — validation completed and found errors
- `6` — authentication is absent or invalid
- `7` — the publishing API could not be reached
- `8` — the publishing API rejected the request
