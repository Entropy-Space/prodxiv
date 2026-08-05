# Product paper format

prodxiv papers use Markdown with YAML front matter. Authors should target a
CommonMark/GFM-compatible subset: headings, paragraphs, block quotes, ordered
and unordered lists, links, emphasis, code spans, fenced code blocks, tables,
and the inline SVG subset described below.

The canonical metadata contract is generated at `schemas/paper.schema.json`.
The canonical section and publication rules are generated at
`schemas/validation-policy.json`.

Schema version 2 is the current authoring format. The archive continues to
read immutable schema-version-1 papers, whose author and scalar status fields
retain their original meaning. New submissions must use schema version 2.

## Product and scope metadata

Every submitted paper identifies its durable product and the scope of the
paper:

```yaml
product_name: Example
scope:
  kind: product
```

Use `kind: feature` with a required `name` for a focused capability. Use
`kind: release` with a required `product_version` for a product release:

```yaml
product_name: Example
scope:
  kind: release
  name: Summer release
  product_version: "2.0"
```

The publishing API creates a product identity for the first paper. Later
papers attach to it through the publication request's `product_id`. The YAML
`version` field is the immutable paper revision number assigned by the service;
it is not the product release version.

## Authors, writers, and contact

Authors are the people or organizations attributed to the paper. GitHub-backed
papers may use the repository owner as an organization author with a
namespaced external ID:

```yaml
authors:
  - id: github:example
    kind: organization
    name: example
    url: https://github.com/example
```

The repository owner is an attribution policy, not an inference from commits.
Do not derive authors or public contact addresses from contributors, commit
authors, or commit email addresses. Explicit authors may omit `id`, but every
schema-version-2 author declares `kind: person` or `kind: organization`.

Writers identify who produced the paper text. Agent writers must identify the
model used:

```yaml
writers:
  - kind: agent
    name: paperbot
    model: deepseek-v4-flash
```

A human-written or human-co-written paper may include an explicitly supplied
`communication_email`. Agent-only papers omit it. The email is a contact for
paper communication, not an identity key.

## Product status observations

Schema-version-2 status records how the value was established:

```yaml
status:
  value: launched
  determination: inferred
  confidence: high
  observed_at: "2026-08-05T00:00:00Z"
  evidence:
    - kind: github_release
      url: https://github.com/example/product/releases/tag/v1.0.0
      tag: v1.0.0
```

An inferred status requires timestamped evidence. A stable public GitHub
release can support `launched`; a GitHub prerelease or an explicitly marked
alpha, beta, preview, or release candidate can support `public_beta`. A public
repository, a `v0.x` tag, missing releases, or an archived flag do not by
themselves establish another status. Use this form when no supported inference
or explicit declaration is available:

```yaml
status:
  value: unknown
  determination: unverified
  confidence: low
```

## Sections

Required level-one sections appear once and in this order:

1. Summary
2. Background
3. Motivation
4. Related Work
5. Core Features
6. Insights and Lessons
7. Limitations
8. References

Cite material claims near the relevant prose with descriptive Markdown links,
and list publicly inspectable sources in References. Every paper can cite at
least its product site, repository, documentation, or named related work. A
local filesystem path is not a public citation.

Benchmarks is optional. Include it before Insights and Lessons only when the
paper provides reproducible methodology or results. Omit it when there is no
measurement rather than publishing an empty placeholder. Tests, planned
measurements, and benchmark-shaped code are not benchmark results.

## Inline SVG figures

Inline SVG may be used for workflows, architecture diagrams, and plots backed
by inspectable data. Keeping the SVG in Markdown versions the figure with the
paper and avoids an external asset dependency.

Wrap the SVG in `figure`, give it an accessible label, and provide a caption:

```html
<figure>
  <svg
    viewBox="0 0 320 120"
    width="320"
    height="120"
    role="img"
    aria-label="Repository-to-draft workflow"
  >
    <rect
      x="10"
      y="30"
      width="100"
      height="60"
      rx="8"
      fill="#f3efe4"
      stroke="#1f4f46"
    />
    <line
      x1="110"
      y1="60"
      x2="210"
      y2="60"
      stroke="#1f4f46"
      stroke-width="2"
    />
    <polygon points="210,60 198,53 198,67" fill="#1f4f46" />
    <text x="60" y="64" text-anchor="middle" font-size="16">Scan</text>
  </svg>
  <figcaption>Repository evidence becomes a private draft.</figcaption>
</figure>
```

The renderer accepts these SVG elements:

- `svg`, `g`, `path`, `rect`, `circle`, `ellipse`;
- `line`, `polyline`, `polygon`;
- `text`, `title`, `desc`.

It accepts geometry, transform, paint, stroke, basic text, viewport,
accessibility, and sizing attributes needed by those elements. It strips
scripts, event handlers, CSS, animation, `foreignObject`, embedded images,
reusable `use` resources, and other active or externally loaded content.

Plots must identify their source data and method in the caption or surrounding
prose. Do not present an illustrative shape as measured evidence.
