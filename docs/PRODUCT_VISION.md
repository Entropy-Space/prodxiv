# prodxiv

## Product vision

prodxiv is a versioned, searchable archive of structured product papers. It
helps product builders document the motivations, decisions, results, and
lessons behind their work in a durable format.

The product borrows the publishing model of an academic archive without
turning product writing into academic theater. Papers are written in Markdown,
optimized for reading on the web, and focused on substance rather than
promotion.

The supported authoring subset, optional sections, citation rules, and safe
inline SVG figures are documented in `docs/PAPER_FORMAT.md`.

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

A product paper is a structured work about a product, concept, feature, or
release. A product is the durable subject; multiple papers may cover different
parts of the same product. Each paper may itself have multiple immutable
revisions.

Product releases and paper revisions are separate concepts. A new product
release normally receives a new paper when it presents a distinct argument or
body of knowledge. Corrections or expansions to that same paper create a new
paper revision.

A recommended paper structure is:

```markdown
---
schema_version: "2"
title:
product_name:
scope:
  kind: product | feature | release
  name:
  product_version:
product_url:
authors:
  - id: github:owner
    kind: person | organization
    name:
    url:
writers:
  - kind: human | agent
    name:
    model: # required for an agent writer
communication_email: # optional; only for a human-written paper
organization:
published_at:
version:
status:
  value: unknown | concept | private_beta | public_beta | launched | discontinued
  determination: declared | inferred | unverified
  confidence: high | medium | low
  observed_at:
  evidence:
    - kind: github_release
      url:
      tag:
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

Authors are the people or organizations attributed to the paper. A repository
owner may be represented by a namespaced external identity such as
`github:owner`; repository commits and commit email addresses are not an
authorship source. Writers record who produced the prose. An agent writer names
both the authoring tool and model, while `communication_email` is optional and
available only when at least one human writer chooses to provide a contact.

Product status is an observation rather than an unsupported scalar assertion.
An inferred status records its observation time and evidence. Drafts use
`unknown` with `unverified` when neither release evidence nor an explicit
declaration establishes a status. Schema version 1 papers remain readable;
new papers use schema version 2.

The serialized `version` field is retained as compact publication notation and
represents the paper revision number. A product release identifier belongs in
`scope.product_version`; it must never be inferred from the paper revision.

Homepage, repository, and documentation links are product resources. Published
paper metadata preserves the links used by that revision as historical
context, while the archive normalizes them separately for product-level
queries and external enrichment.

Mutable external observations such as GitHub star counts never enter paper
Markdown or revision metadata. The archive may display them as timestamped
product-resource enrichment, preserving their observation history separately.

Not every section is required. Omit Benchmarks when no reproducible
measurement exists rather than publishing an empty placeholder. When a paper
does make measured claims, benchmark methodology is first-class content and
should identify its date, environment, dataset, comparison target, and
reproducibility notes. Limitations remain required.

## Publishing model

Individuals and teams should be able to publish papers for both working
products and pre-build concepts. Submissions should be open, subject to format
validation and community moderation rather than mandatory editorial approval.

Published revisions are immutable. Authors update a paper by publishing a new
revision instead of silently changing its historical record.

An identifier may look like:

```text
prodxiv:2607.00001A
v1 — Initial publication
v2 — Corrected architecture description
v3 — Expanded benchmark methodology
```

Each paper should expose:

- A permanent identifier.
- Authors, writers, and optional human-writer contact.
- Product status, its determination, and topics.
- Publication and revision dates.
- Revision history.
- Rendered Markdown and raw source.
- References and links to related products.
- Benchmark methodology and reproducibility notes.

Product relationships should support more than conventional citations. Useful
relationships include `inspired_by`, `built_on`, `alternative_to`, and
`supersedes`.

## Initial product experience

The first release should focus on five surfaces:

1. **Explore** — Recent and notable papers, topic filters, and search.
2. **Paper** — The rendered paper, metadata, revision history, citations, and
   raw Markdown.
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

The product's credibility should come from its content model, revision history,
and honest limitations—not from visual imitation.

## Product principles

1. **Substance over promotion.** Papers explain decisions and tradeoffs rather
   than reproduce launch copy.
2. **History over silent updates.** Meaningful changes create new immutable
   versions.
3. **Method over confidence.** When benchmarks are present, they should
   explain how they were produced and what they do not establish. Papers
   without measurements should omit the section rather than imply evidence.
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
