# Paperbot drafting policy

## Evidence states

Assign exactly one state to every substantive claim:

- `verified`: directly supported by implementation, tests, reproducible
  benchmarks, or factual documentation;
- `inferred`: a reasonable interpretation of evidence that still needs author
  confirmation;
- `author_provided`: history, intent, judgment, or qualitative context supplied
  by the author;
- `missing_evidence`: a proposed or existing claim that lacks adequate support.

README and website marketing copy may locate a claim, but do not make it
verified by themselves. Never convert an inference into a fact through more
confident wording.

## Claim records

Keep evidence in the scan-generated JSON bundle. Add a claim object with:

- a stable, descriptive, snake_case `claim_id`;
- the exact factual `statement`;
- its `provenance_state`;
- `locations` pointing to supporting `source_id` values and the narrowest
  practical line ranges;
- optional `notes` for uncertainty, contradictions, or author context.

Use only source IDs already present in the bundle. Re-run the scan rather than
inventing hashes or source entries. A verified claim should normally have at
least one location. Use multiple locations when implementation and tests
together support the statement.

## Section guidance

- **Summary:** State what exists, who it serves, and the paper's scope without
  promotional superlatives.
- **Background:** Separate documented context from author-supplied history.
- **Motivation:** Prefer author answers. Code rarely proves why a product
  exists.
- **Related Work:** Name inspectable alternatives and influences. Avoid
  superiority claims without comparable evidence.
- **Core Features:** Tie each material behavior to implementation,
  documentation, or tests.
- **Architecture:** Distinguish observed boundaries from inferred design
  intent.
- **Benchmarks:** Include results only with reproducible methodology, inputs,
  environment, and limitations. If none exist, say so.
- **Insights and Lessons:** Ask the author about tradeoffs, surprises, failed
  approaches, and changed assumptions.
- **Limitations:** Preserve known constraints, negative evidence, and open
  questions.
- **References:** Point to inspectable sources without exposing private paths
  or sensitive material.

## Author interview

Ask only questions that will materially improve incomplete sections. Group a
small number of related questions and explain which gap each answer fills.
Prioritize:

1. What user problem started the product?
2. Which alternatives were tried or rejected, and why?
3. Which constraints drove the architecture?
4. What tradeoffs or limitations are intentional?
5. What failed, surprised the team, or changed their view?
6. What benchmark setup and raw results can be reproduced?

Record answers as author-provided evidence. Do not imply independent
verification.

## Safety and review

Do not quote or summarize secrets, credentials, environment files, private
user data, generated code, vendored dependencies, or excluded material.
Surface conflicting evidence instead of choosing the more favorable source.
Keep benchmark absence and incomplete sections explicit.

Before handoff, inspect the paper diff, validate the draft and referenced
evidence bundle, and list unresolved questions. Never publish automatically.
