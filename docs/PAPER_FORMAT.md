# Product paper format

prodxiv papers use Markdown with YAML front matter. Authors should target a
CommonMark/GFM-compatible subset: headings, paragraphs, block quotes, ordered
and unordered lists, links, emphasis, code spans, fenced code blocks, tables,
and the inline SVG subset described below.

The canonical metadata contract is generated at `schemas/paper.schema.json`.
The canonical section and publication rules are generated at
`schemas/validation-policy.json`.

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
