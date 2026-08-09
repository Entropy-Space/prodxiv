# Paperbot drafting guidance

## Repository interpretation

Use code and documentation to describe observable implementation. Ask the
author before assigning product intent, historical motivation, or strategic
meaning to an implementation choice.

README and website marketing statements may help locate features, but do not
repeat promotional comparisons or superlatives as facts. Prefer precise,
bounded descriptions.

## Evidence and citations

Treat repository evidence, external sources, author statements, and agent
inference as different evidence classes during drafting. Every material claim
should be traceable to at least one of the first three, and an inference should
be labeled for author review rather than presented as established fact.

For external research:

- name specific products, websites, repositories, documentation, or papers;
- prefer official product sites, documentation, and source repositories for
  claims about what a product does;
- use independent sources when a comparison requires a perspective the product
  owner cannot establish;
- cite the source close to the claim with a descriptive Markdown link;
- include a complete, publicly inspectable link in References;
- never use a private filesystem path as a public citation;
- never place private source text, private paths, credentials, or undisclosed
  implementation details into a search query.

Related Work should explain the relevant relationship, not merely list names.
State whether another product influenced the work, supplies an underlying
component, addresses a similar problem, or represents a rejected alternative.
Do not claim superiority unless a cited comparison supports the exact scope and
method.

## Figures

Use a figure only when it makes a workflow, architecture boundary, comparison,
or measured result materially easier to understand than prose. Prefer a small
inline SVG for durable workflows and plots because it remains part of the exact
versioned Markdown source.

Inline SVG must use only inert shapes and text. Do not include scripts, event
handlers, CSS, animation, `foreignObject`, external images, or reusable
external resources. Every SVG must have `role="img"` and an `aria-label`, and
every figure must have a `figcaption`. A plot caption or its surrounding prose
must identify the source data and method. Do not create a plot when no
inspectable data exists.

## Section guidance

- **Voice:** Evidence refers to the product neutrally by name. Paper prose is
  written on behalf of the credited authors and uses `we`, `our`, and `us` for
  their work and decisions. Do not narrate the authors as “they” or “the team.”
  Intentional claims such as “we chose” require author input or explicit source
  evidence.
- **Summary:** State the problem, who experiences it, and the solution thesis.
- **Background:** Explain the problem domain, affected users, constraints, and
  why the problem is difficult. Separate documented context from history
  supplied by the author.
- **Motivation:** Explain how and why the authors pursue this solution and
  which objectives shape it. Prefer author answers because code rarely
  establishes intention.
- **Related Work:** Explain how specific, inspectable alternatives and
  influences approach the same problem, cite primary sources, and explain each
  relationship. Avoid unsupported superiority claims.
- **Core Features:** Map observable mechanisms and user-facing behavior to the
  problem constraints they address.
- **Architecture:** Separate observed technical boundaries from the author's
  explanation of why they exist.
- **Benchmarks:** Include results only with reproducible methodology, inputs,
  environment, and limitations. Omit the entire section when no reproducible
  methodology or results exist. Do not treat tests, planned measurements, or
  benchmark-shaped code as results.
- **Insights and Lessons:** Ask about tradeoffs, surprises, failed approaches,
  and changed assumptions.
- **Limitations:** Preserve known constraints and open questions.
- **References:** Provide descriptive public links for cited repositories,
  documentation, products, websites, and papers. Do not expose private paths
  or sensitive material.

## Author interview

Ask only questions that materially improve incomplete sections. Group a small
number of related questions and explain which gap each answer fills.
Prioritize:

1. What user problem started the product?
2. Which alternatives were tried or rejected, and why?
3. Which constraints drove the architecture?
4. What tradeoffs or limitations are intentional?
5. What failed, surprised the team, or changed their view?
6. What benchmark setup and raw results can be reproduced?

Do not imply that author recollection was independently checked.

## Safety and review

Do not quote or summarize secrets, credentials, environment files, private user
data, generated code, vendored dependencies, or excluded material. Surface
conflicting repository information instead of choosing the more favorable
description. Do not add a Benchmarks section merely to report its absence; keep
unsupported measured claims and other incomplete sections explicit.

Before handoff, inspect the paper diff, validate the draft, and list unresolved
questions plus material claims that lack an inspectable source. Never publish
automatically.
