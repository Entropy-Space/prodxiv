# prodxiv web

The Astro website provides public reading and a separate author workspace:

- checked-in example papers are prerendered at `/papers/<content-id>`;
- published database records are rendered on demand at
  `/papers/<paper-id>/v<revision>`.
- current pending drafts are read at `/drafts` and `/drafts/<paper-uuid>`;
- authenticated review and editing remain at `/review/drafts` and
  `/review/drafts/<paper-uuid>`.

The on-demand route uses Astro's Vercel adapter and fetches the exact immutable
revision from the public Axum API. Markdown is rendered on the server and
sanitized before it is included in the page.

Published Markdown may contain inline SVG figures for workflows, architecture,
and data-backed plots. The renderer accepts only inert shape and text elements
with a restricted presentation-attribute set. It strips scripts, event
handlers, embedded HTML, CSS, animation, and external SVG resources. Figures
should include an accessible label and a `figcaption`; plots should identify
their source data and method in the caption or surrounding prose.

See `docs/PAPER_FORMAT.md` for the supported paper Markdown and SVG subset.

The homepage is also rendered on demand. It requests cursor-paginated latest
revisions from the public API and links each result to its exact immutable
reader route. Checked-in reference papers remain visible if the API cannot be
reached.

Search and topic filters are applied by the API across the archive, not just
to the visible page. Readers show confirmed revision history, revision-bound
citations, and exact archived Markdown downloads at
`/papers/<paper-id>/v<revision>/source.md`. Public pages disclose agent writers
separately from author attribution; attribution does not imply endorsement.

Draft reading never forwards a publishing credential or renders review notes.
Only current pending drafts are public through the restricted read projection.
Approved/rejected drafts and retained history stay in the authenticated
workspace. A published draft link resolves to the immutable paper through its
recorded UUID mapping. Mutable draft pages are not cached or indexed. Malformed
draft metadata produces a visible incomplete state rather than a publication
claim.

## Configuration

Set `PRODXIV_API_URL` to the publishing API's public base URL:

```sh
PRODXIV_API_URL=http://127.0.0.1:3000 bun --filter @prodxiv/web dev --background
```

Production must use HTTPS. Localhost HTTP is accepted for development.
`PRODXIV_API_URL` is server-only and must be configured on the `prodxiv-web`
Vercel project. The public reader does not use `PRODXIV_PUBLISH_TOKEN`.

No feature flag or website secret is required for public draft reading. Review
still uses the author token as the HTTP Basic password and keeps it server-side;
accounts are a later step.

Stop the background dev server with `bun --filter @prodxiv/web astro dev stop`.

## Commands

Run from the repository root:

```sh
bun run check:web
bun run test:web
bun run build:web
```
