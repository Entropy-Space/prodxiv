# prodxiv

## Product vision

prodxiv is a versioned, searchable archive of structured product papers. It
helps product builders document the motivations, decisions, evidence, and
lessons behind their work in a durable format.

The product borrows the publishing model of an academic archive without
turning product writing into academic theater. Papers are written in Markdown,
optimized for reading on the web, and focused on substance rather than
promotion.

> Product ideas, documented properly.

## Why it should exist

Product knowledge is usually fragmented across landing pages, launch posts,
internal documents, source code, and social media. These sources tend to
explain what launched, but rarely preserve why it was built, which alternatives
were considered, how claims were measured, or what the team learned.

prodxiv creates a canonical record for that knowledge. It should help:

- Builders learn from the reasoning behind other products.
- Authors explain their work with more depth than a launch page allows.
- Researchers trace related products, ideas, and technical approaches.
- Future teams understand how a product and its decisions evolved.

The initial experience should optimize for builders and curious readers.
Recruiting, promotion, and investor discovery may emerge later, but should not
shape the publishing format.

## The product paper

A product paper is a structured introduction to a product, concept, or major
product revision. It combines narrative context with implementation evidence.

A recommended paper structure is:

```markdown
---
title:
product_url:
authors:
organization:
published_at:
version:
status: concept | private_beta | public_beta | launched | discontinued
topics:
license:
repository_url:
---

# Summary
# Background
# Motivation
# Related Work
# Core Features
# Architecture
# Benchmarks
# Insights and Lessons
# Limitations
# References
```

Not every section must be long, but limitations and benchmark methodology
should be treated as first-class content. A benchmark should identify its date,
environment, dataset, comparison target, and reproducibility notes.

## Publishing model

Individuals and teams should be able to publish papers for both working
products and pre-build concepts. Submissions should be open, subject to format
validation and community moderation rather than mandatory editorial approval.

Published versions are immutable. Authors update a paper by publishing a new
version instead of silently changing its historical record.

An identifier may look like:

```text
prodxiv:2607.0042
v1 — Initial concept
v2 — Public launch
v3 — Architecture and benchmark update
```

Each paper should expose:

- A permanent identifier.
- Authors and organization.
- Product status and topics.
- Publication and revision dates.
- Version history.
- Rendered Markdown and raw source.
- References and links to related products.
- Evidence and methodology attached to substantive claims.

Product relationships should support more than conventional citations. Useful
relationships include `inspired_by`, `built_on`, `alternative_to`, and
`supersedes`.

## Initial product experience

The first release should focus on five surfaces:

1. **Explore** — Recent and notable papers, topic filters, and search.
2. **Paper** — The rendered paper, metadata, evidence, version history,
   citations, and raw Markdown.
3. **Submit** — A Markdown editor with preview and structural validation.
4. **Lineage** — Connections among related products and ideas.
5. **Profiles** — Papers and revisions associated with an author, team, or
   product.

## Design direction

The interface should feel scholarly, quiet, and text-first without copying
arXiv's identity literally.

- Dense but readable layouts.
- Strong serif typography for long-form reading.
- A muted paper-like surface and restrained accent color.
- Minimal decorative imagery.
- Excellent support for tables, code, diagrams, footnotes, and citations.
- Clear identifiers, version information, and product status near the title.

The product's credibility should come from its content model, version history,
and evidence—not from visual imitation.

## Product principles

1. **Substance over promotion.** Papers explain decisions and tradeoffs rather
   than reproduce launch copy.
2. **History over silent updates.** Meaningful changes create new immutable
   versions.
3. **Evidence over confidence.** Claims and benchmarks should show how they
   were established.
4. **Open contribution with visible quality signals.** Publishing should be
   accessible while validation and moderation protect the archive.
5. **Readable by default.** Markdown source should render into an excellent
   long-form reading experience.
6. **Honest incompleteness.** Limitations and unanswered questions belong in
   the paper.

## Initial scope

The first release does not need to solve peer review, monetization, recruiting,
or investor discovery. It should prove that builders will create and read
high-quality product papers, and that versioned product knowledge is more
valuable than another launch directory.
