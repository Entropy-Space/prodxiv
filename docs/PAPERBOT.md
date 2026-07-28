# Paperbot

## Purpose

Paperbot turns an existing codebase and its documentation into an initial
product paper draft.

It is a research assistant for authors, not an autonomous publisher. Its role
is to reduce the work required to create a thoughtful first draft while
preserving author control and the credibility of prodxiv.

The guiding rule is:

> Infer implementation. Ask about intention.

Code can reveal architecture, dependencies, features, tests, releases, and
sometimes performance characteristics. It cannot reliably explain why a
product exists, why alternatives were rejected, or what its creators learned.
Paperbot should describe what it can observe and turn missing context into
specific author questions.

## Inputs and outputs

Paperbot may analyze:

- A local repository.
- A public repository URL.
- A private repository with explicit authorization.
- Product documentation selected by the author.
- Optional notes and answers supplied during an author interview.

The scanner produces a private manifest containing the repository revision and
the paths and types of selected files. The manifest coordinates local analysis;
it is not part of the published paper format.

The primary output is a private Markdown draft following the prodxiv paper
structure. The draft should leave unanswered questions and incomplete sections
visible instead of filling them with speculation.

## Drafting workflow

1. **Connect a source.** The author selects a repository and any additional
   documents.
2. **Confirm scope.** Paperbot shows which directories and files it may read
   and which are excluded.
3. **Create a scan manifest.** The CLI records the repository revision and
   selected file inventory.
4. **Understand the project.** The drafting agent reads relevant files and
   detects languages, architecture, dependencies, tests, releases, and
   benchmark suites.
5. **Research related work.** The agent identifies specific products,
   websites, repositories, documentation, and papers, verifies claims against
   inspectable sources, and records public citations without disclosing private
   repository contents.
6. **Generate a private draft.** The agent completes sections supported by
   repository evidence, external sources, or author statements and leaves
   uncertain details as questions.
7. **Interview the author.** It asks a short, adaptive set of questions about
   motivation, background, alternatives, tradeoffs, and lessons.
8. **Revise collaboratively.** Author answers are incorporated without
   overwriting deliberate manual edits.
9. **Review and approve.** The author reviews privacy, accuracy, and
   completeness before any submission.
10. **Publish explicitly.** After approval, the CLI submits the exact reviewed
   Markdown to the authoritative API and reports its allocated identifier.

## Example draft behavior

```markdown
# Motivation

> Author input required:
> What user problem originally motivated this project?
> Why were existing tools insufficient?

# Core Features

## Local-first persistence

The repository implements local workspace storage and asynchronous
synchronization.

> Author review:
> Is offline operation a product goal or only an implementation detail?

# Limitations

No reproducible benchmark results were found, so this draft omits a
Benchmarks section. It does not make performance claims.
```

Paperbot should never turn missing context into polished but unsupported prose.

## Revision assistance

When a repository changes, Paperbot can compare the relevant commit range with
the latest paper and propose a revision.

A revision proposal might report:

> Authentication was added, the storage architecture changed, and two
> documented limitations may no longer apply.

The proposal should identify affected sections and preserve all existing author
edits. The author decides whether the changes justify a new published version.

## Safety and trust boundaries

Paperbot must:

- Never publish automatically.
- Never invent benchmark results or experimental methodology.
- Never treat README marketing statements as established facts.
- Never include secrets, credentials, environment files, user data, or other
  sensitive material in a draft.
- Exclude generated code, vendored dependencies, and irrelevant large assets
  by default.
- Show which files were selected for analysis.
- Preserve author edits when revising individual sections.
- Keep uncertainty visible during drafting.

The `publish` command is deliberately separate from drafting. It validates the
submission, displays its destination and source hash, and requires an
interactive confirmation or an explicit `--yes`. Agents must never infer that
drafting approval also authorizes publication.

Local publishing credentials live in `~/.tokn/prodxiv/auth.toml` with
owner-only permissions. The file may include the publishing API URL and public
site URL so successful publication output can link to both the API record and
the human-readable paper. Environment variables are supported for CI. The
token is temporary MVP authorization and must never be included in paper
content, diagnostics, or command output. `paperbot auth` creates a commented
credential template when the file does not exist. Publishing never creates or
changes the credential file.

Private and unpublished code introduces additional trust requirements. Local
analysis is the default so repository contents do not need to be uploaded. If
remote analysis is supported later, retention, access, deletion, and
model-training policies must be explicit.

## Initial scope

The first version should support:

- Local repositories through a CLI or agent-assisted workflow.
- Markdown documentation.
- Repository structure, dependency, test, and benchmark detection.
- A section-complete Markdown scaffold.
- An optional Benchmarks section only when reproducible methodology or results
  exist.
- Agent-assisted drafting and a focused author interview.
- Structural validation and private preview.
- Manual approval before submission.

Private repository integrations can follow once authentication, data retention,
and user trust are designed deliberately. Issue trackers, chats, analytics, and
design tools are not required to validate the core drafting experience.

## Success criteria

Paperbot succeeds when it:

- Produces a useful draft faster than an author can start from a blank page.
- Makes incomplete or unsupported statements easier to notice.
- Asks questions that improve the paper rather than merely filling sections.
- Describes observed product behavior without inventing product intent.
- Helps authors keep papers current without erasing historical versions.
- Leaves authors feeling that the paper is theirs.
