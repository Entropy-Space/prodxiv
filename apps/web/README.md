# prodxiv web

The Astro website renders two kinds of paper pages:

- checked-in example papers are prerendered at `/papers/<content-id>`;
- published database records are rendered on demand at
  `/papers/<paper-id>/versions/<version>`.

The on-demand route uses Astro's Vercel adapter and fetches the exact immutable
version from the public Axum API. Markdown is rendered on the server and
sanitized before it is included in the page.

Published Markdown may contain inline SVG figures for workflows, architecture,
and data-backed plots. The renderer accepts only inert shape and text elements
with a restricted presentation-attribute set. It strips scripts, event
handlers, embedded HTML, CSS, animation, and external SVG resources. Figures
should include an accessible label and a `figcaption`; plots should identify
their source data and method in the caption or surrounding prose.

See `docs/PAPER_FORMAT.md` for the supported paper Markdown and SVG subset.

The homepage is also rendered on demand. It requests cursor-paginated latest
versions from the public API and links each result to its exact immutable
reader route. Checked-in reference papers remain visible if the API cannot be
reached.

## Configuration

Set `PRODXIV_API_URL` to the publishing API's public base URL:

```sh
PRODXIV_API_URL=http://127.0.0.1:3000 bun --filter @prodxiv/web dev
```

Production must use HTTPS. Localhost HTTP is accepted for development.
`PRODXIV_API_URL` is server-only and must be configured on the `prodxiv-web`
Vercel project. The public reader does not use `PRODXIV_PUBLISH_TOKEN`.

## Commands

Run from the repository root:

```sh
bun run check:web
bun run test:web
bun run build:web
```
