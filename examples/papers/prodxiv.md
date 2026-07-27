---
schema_version: "1"
paper_id: "prodxiv:2607.0001"
title: "prodxiv: A Versioned Archive for Product Knowledge"
summary: "A proposal for preserving the motivations, decisions, results, and lessons behind products as durable, versioned Markdown papers."
authors:
  - name: "prodxiv contributors"
organization: "prodxiv"
published_at: "2026-07-27"
version: 1
status: "concept"
topics:
  - "developer_tools"
  - "product_design"
  - "knowledge_management"
license: "CC BY 4.0"
repository_url: "https://github.com/Entropy-Space/prodxiv"
---

# Summary

prodxiv is a proposed open archive for structured product papers. It gives
builders a durable place to explain why a product exists, which alternatives
they considered, how the product works, what results they observed, and what
they learned.

Papers are written in Markdown and published as immutable versions. The format
borrows the useful archival properties of academic publishing without asking
product teams to imitate academic writing.

# Background

Product knowledge is commonly split across launch posts, marketing pages,
source repositories, internal decision records, issue trackers, and social
media. These sources serve different audiences and change at different rates.
Together, they rarely form a stable account of how a product came to exist.

Launch platforms are useful for discovery but emphasize the moment of release.
Documentation explains how to use a product but usually omits its history.
Source code can show implementation but cannot reliably explain motivation.
Internal records contain valuable decisions but are seldom available to future
users or builders.

# Motivation

The absence of durable product narratives makes the same design questions
unnecessarily expensive to revisit. Builders can see what shipped, but not
which constraints shaped it, which approaches failed, or how the team measured
success.

prodxiv is motivated by three goals:

1. Preserve the reasoning behind products as they evolve.
2. Make product knowledge useful to people outside the original team.
3. Reward clear methodology, limitations, and learning rather than
   promotional confidence.

# Related Work

Academic archives demonstrate the value of permanent identifiers, revisions,
citations, and stable access. Product launch directories demonstrate the value
of lightweight publishing and discovery. Architecture decision records,
request-for-comment documents, and engineering blogs demonstrate the value of
capturing decisions near the work.

prodxiv combines parts of these models but does not replace them. It is not a
peer-review system, launch leaderboard, documentation host, or source-code
repository. A product paper links these materials into a coherent,
versioned account.

# Core Features

## Structured Markdown papers

Each paper follows a recognizable structure covering summary, background,
motivation, related work, core features, architecture, benchmarks, insights,
limitations, and references. Authors may adapt the structure when a section
does not fit their product.

## Immutable versions

Published versions are immutable. Authors publish a new version when the
product or its documented understanding changes. Readers can inspect the
history instead of encountering silent edits.

## Product lineage

Papers can express relationships such as `inspired_by`, `built_on`,
`alternative_to`, and `supersedes`. This creates a navigable history of product
ideas rather than a flat collection of launch pages.

## Reproducible benchmark reporting

Benchmark sections should describe methodology, environment, inputs, results,
and limitations. Papers without meaningful benchmarks should say so directly
instead of filling the section with promotional metrics.

## Paperbot

Paperbot is a local-first Bun CLI and portable Agent Skill. It inspects an
authorized repository, prepares a private Markdown scaffold, and asks the
author targeted questions about information that code cannot reveal.

# Architecture

The planned system has three primary components:

- An Astro website for reading and editing product papers.
- A Rust and Axum API that owns publication, authorization, identifiers,
  immutable versions, and audit records.
- Paperbot, implemented as a Bun and TypeScript CLI with an Agent Skill.

PostgreSQL stores paper metadata, Markdown, relationships, and audit records.
The production deployment is planned to use Neon Postgres, while local
development uses PostgreSQL through Podman.

Language-neutral JSON Schema and OpenAPI documents connect the Rust domain
model to generated TypeScript types and clients.

# Benchmarks

No product benchmarks are available at the concept stage.

The first useful measurements should evaluate:

- Time required to produce a complete first draft with and without Paperbot.
- Number of factual corrections required during author review.
- Number of author questions that materially improve incomplete sections.
- Reader comprehension of motivation, tradeoffs, and limitations.
- Author effort required to publish a meaningful revision.

Benchmark methodology and results will be added only after a working vertical
slice can be tested against varied repositories.

# Insights and Lessons

The design process has produced three early insights.

First, product papers need versioning more than static essays do because the
underlying products continue to change. Second, code can describe
implementation but cannot explain intention. Third, automated drafting is
useful only when uncertainty remains visible to the author.

These observations are hypotheses until the format is used by product teams
outside the project.

# Limitations

prodxiv is currently a concept and early implementation. It has not yet shown
that builders will maintain papers after publication or that readers prefer
structured product papers to existing formats.

The archive also faces unresolved moderation, authorship, licensing, sensitive
source analysis, and long-term preservation questions. Paperbot cannot
determine private motivations from public code, and its inferences may be
incorrect even when they appear plausible.

# References

1. The prodxiv product vision, `docs/PRODUCT_VISION.md`.
2. The Paperbot product specification, `docs/PAPERBOT.md`.
3. The Agent Skills specification, <https://agentskills.io/specification>.
