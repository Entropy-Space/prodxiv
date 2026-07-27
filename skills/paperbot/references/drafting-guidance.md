# Paperbot drafting guidance

## Repository interpretation

Use code and documentation to describe observable implementation. Ask the
author before assigning product intent, historical motivation, or strategic
meaning to an implementation choice.

README and website marketing statements may help locate features, but do not
repeat promotional comparisons or superlatives as facts. Prefer precise,
bounded descriptions.

## Section guidance

- **Summary:** State what the product is, who it serves, and the paper's scope.
- **Background:** Separate documented context from history supplied by the
  author.
- **Motivation:** Prefer author answers. Code rarely explains why a product
  exists.
- **Related Work:** Name inspectable alternatives and influences. Avoid
  unsupported superiority claims.
- **Core Features:** Describe observable behavior and important user-facing
  constraints.
- **Architecture:** Separate observed technical boundaries from the author's
  explanation of why they exist.
- **Benchmarks:** Include results only with reproducible methodology, inputs,
  environment, and limitations. If no results exist, say so.
- **Insights and Lessons:** Ask about tradeoffs, surprises, failed approaches,
  and changed assumptions.
- **Limitations:** Preserve known constraints and open questions.
- **References:** Link relevant repositories, documentation, and related
  products without exposing private paths or sensitive material.

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
description. Keep absent benchmarks and incomplete sections explicit.

Before handoff, inspect the paper diff, validate the draft, and list unresolved
questions. Never publish automatically.
