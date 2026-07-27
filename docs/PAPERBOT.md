# Paperbot

## Purpose

Paperbot turns an existing codebase and its documentation into an
evidence-backed product paper draft.

It is a research assistant for authors, not an autonomous publisher. Its role
is to reduce the work required to create a thoughtful first draft while
preserving author control and the credibility of prodxiv.

The guiding rule is:

> Infer implementation. Ask about intention.

Code can reveal architecture, dependencies, features, tests, releases, and
sometimes performance characteristics. It cannot reliably explain why a
product exists, why alternatives were rejected, or what its creators learned.
Paperbot should draft what it can substantiate and convert uncertainty into
specific author questions.

## Inputs and outputs

Paperbot may analyze:

- A local repository.
- A public repository URL.
- A private repository with explicit authorization.
- Product documentation selected by the author.
- Optional notes and answers supplied during an author interview.

Its primary output is a private Markdown draft following the prodxiv paper
structure. The draft should include source evidence, confidence states,
unanswered questions, and suggested work for incomplete sections.

## Claim states

Every generated substantive claim should have an explicit provenance state:

- **Verified** — Directly supported by code, tests, benchmarks, or
  documentation.
- **Inferred** — A reasonable interpretation that requires author
  confirmation.
- **Author-provided** — Motivation, history, intent, or qualitative insight
  supplied by an author.
- **Missing evidence** — A claim that should not be presented as established
  until supporting evidence is added.

These states may be visible during drafting without all appearing in the final
published prose. The final paper should retain enough citations and methodology
to make important claims inspectable.

## Drafting workflow

1. **Connect a source.** The author selects a repository and any additional
   documents.
2. **Confirm scope.** Paperbot shows which directories and files it may read
   and which are excluded.
3. **Understand the project.** It detects languages, architecture,
   dependencies, documentation, tests, releases, and benchmark suites.
4. **Build an evidence map.** Features and technical claims are linked to
   supporting files, symbols, tests, or documents.
5. **Generate a private draft.** Paperbot writes the sections it can support
   and marks gaps instead of filling them with speculation.
6. **Interview the author.** It asks a short, adaptive set of questions about
   motivation, background, alternatives, tradeoffs, and lessons.
7. **Revise collaboratively.** Author answers are incorporated without
   overwriting deliberate manual edits.
8. **Review evidence and privacy.** The author sees claims, contributing
   sources, exclusions, and possible sensitive content.
9. **Approve submission.** Nothing is published without explicit author
   approval.

## Example draft behavior

```markdown
# Motivation

> Author input required:
> What user problem originally motivated this project?
> Why were existing tools insufficient?

# Core Features

## Local-first persistence

The application stores workspace state locally and synchronizes changes
through an asynchronous replication layer.

Evidence:
- `src/storage/local_store.rs`
- `src/sync/replicator.rs`

# Benchmarks

No reproducible benchmark suite was found.

> Suggested benchmark:
> Measure synchronization latency with 1, 10, and 100 concurrent clients.
```

Paperbot should never turn the absence of evidence into a polished but
unsupported claim.

## Revision assistance

Paperbot should also help maintain published papers. When a repository changes,
it can compare the relevant commit range with the latest paper version and
propose a revision.

A revision proposal might report:

> Authentication was added, the storage architecture changed, and two
> documented limitations may no longer apply.

The proposal should identify affected sections and preserve all existing author
edits. The author decides whether the changes justify a new published version.

## Safety and trust boundaries

Paperbot must:

- Never publish automatically.
- Never invent benchmark results or experimental methodology.
- Never treat README marketing claims as verified solely because they are
  documented.
- Never include secrets, credentials, environment files, user data, or other
  sensitive material in a draft.
- Exclude generated code, vendored dependencies, and irrelevant large assets
  by default.
- Show which files and documents contributed to the draft.
- Let authors remove sources and regenerate affected claims.
- Preserve author edits when regenerating individual sections.
- Make uncertainty visible instead of hiding it behind fluent prose.

Private and unpublished code introduces additional trust requirements. A local
analysis mode is preferable because it can produce an evidence map without
uploading the full repository. If remote analysis is supported, its retention,
access, deletion, and model-training policies must be explicit.

## Initial scope

The first version should support:

- Local repositories through a CLI or desktop-assisted workflow.
- Public repository URLs.
- Markdown documentation.
- Repository structure, dependency, test, and benchmark detection.
- Evidence-linked paper drafting.
- A focused author interview.
- Private preview and manual approval.

Private repository integration can follow once authentication, data retention,
and user trust are designed deliberately. Broad integrations with issue
trackers, chats, analytics, and design tools are valuable later, but are not
required to validate the core drafting experience.

## Success criteria

Paperbot succeeds when it:

- Produces a useful draft faster than an author can start from a blank page.
- Makes unsupported claims easier to notice.
- Asks questions that improve the paper rather than merely filling sections.
- Generates traceable descriptions of product behavior from real evidence.
- Helps authors keep papers current without erasing historical versions.
- Leaves authors feeling that the paper is theirs.
