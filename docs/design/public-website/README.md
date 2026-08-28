# Public website design

Status: approved design direction; not a production implementation.

This design starts with public reading: finding published papers, reading an
exact revision, and following pending drafts before publication. It preserves
the distinction between an immutable publication and a mutable working draft.
Accounts and broader availability policy are separate follow-ups.

## Preview

Open [preview.html](./preview.html) locally in a modern browser. It is a
standalone export of the approved interactive wireframes; no application server,
database, credentials, or model access is needed. The export includes optional
CDN-loaded presentation helpers, but the prototype itself makes no API calls.
Nothing is deployed by this design change.

[wireframe.html](./wireframe.html) is the editable HTML fragment. Keep it as the
source of truth and regenerate the standalone preview after changing it. The
preview was exported with the visualization renderer bundled with Codex; it is
a design artifact, not an application entry point or a new production runtime.

Try these paths:

1. Search the Papers list, choose a topic, and clear an empty result.
2. Open a published paper; change its revision and inspect its citation and
   source preview.
3. Open Drafts, then compare a bot-owned draft with an author-managed draft.
4. Use the contents links, return to the list, and repeat at a narrow width.

All papers, identifiers, dates, and provenance values are illustrative. The
local search filters only these fixtures, not the real archive. Source previews
are abbreviated examples, not valid submission fixtures or downloadable
archives. Links use the reserved `prodxiv.example` domain. Navigation changes
local prototype state; it does not exercise real routes or authentication.

## Reading experience

### Published archive

- Use a compact introduction followed by readable paper rows, not a large
  marketing hero or a dashboard of metrics.
- Show title, summary, author attribution, writer disclosure, topic, publication
  date, short paper identifier, and exact revision. Use the newest published
  revisions first, with pagination in the real archive.
- Search and topic filtering are the intended discovery controls. They must
  query the archive, not silently filter only the currently loaded page.
- Give pending drafts a visible entry point, without mixing them into published
  results or treating them as published papers.

### Pending drafts

- Public readers can browse the pending queue and read a current draft without
  signing in. This is the target behavior, not the current access policy.
- Order the queue by most recently edited. Show useful titles and summaries,
  revision, last edit time, writer disclosure, ownership, and `pending_review`
  status instead of UUID-only rows.
- Label every draft as unpublished and mutable, including on a direct reader
  link. Author attribution is not evidence of author endorsement.
- A saved draft can be incomplete or invalid for publication. Display that
  uncertainty honestly; a readable page is not a validation result.
- Keep review and editing controls restricted. Public reading does not grant
  permission to approve, reject, edit, delete, or publish.

The existing workflow remains: approval is bound to an exact revision; rejection
retains the draft; an edit uploads a new revision and resets review. An author
edit transfers ownership to the author. The daily scheduler may atomically
approve and publish an unchanged, bot-owned suggestion from a previous run, but
never auto-approve an author-owned revision. Explicitly approved revisions may
be published by a later run. The interface must say a bot-owned draft _may_
publish next run, not promise that it will.

### Paper reader

- Share the reading layout, typography, and section navigation across published
  papers and public drafts. Their status and available actions stay distinct.
- Put identity, exact revision, date, attributed authors, and writers near the
  title. Keep model and safe tool-version provenance discoverable. Do not imply
  that repository owners endorsed automatically generated prose.
- Use a comfortable long-form measure and serif text. Preserve supported
  Markdown tables, code, figures, citations, and historical schema versions.
  Render through the existing sanitization boundary.
- Make contents and provenance collapsible on small screens. Keep primary
  navigation and essential metadata available on mobile.
- Published readers offer revision-bound citations and the exact archived
  Markdown. Do not regenerate source from rendered HTML or current metadata.
- Show only revisions confirmed by the API, with the selected revision and any
  newer available revision clearly identified. Hide a single-option picker.
- Draft readers show the UUID and current draft revision, an unpublished
  warning, and a draft link instead of a publication citation.

### Navigation and visual language

Use a quiet, text-first archive identity: a muted paper-like surface, restrained
accent, readable density, and strong serif titles. Support light and dark
appearance without sacrificing contrast or native focus indicators. Avoid
decorative imagery, popularity scores, and promotional claims.

The intended public navigation includes Papers, Drafts, Trending, and About.
These wireframes cover Papers, Drafts, About, and the shared reader; they do not
redesign Trending. Preserve the existing Trending date/language/period controls
and CSV export during implementation. Author tools should not dominate public
navigation, but their authenticated routes remain available.

## Identity and routes

| Surface            | Target route                     | Meaning                                          |
| ------------------ | -------------------------------- | ------------------------------------------------ |
| Published archive  | `/`                              | Published papers; discovery and pagination       |
| Pending queue      | `/drafts`                        | Public-readable pending drafts, not publications |
| Current draft      | `/drafts/{paper_uuid}`           | Mutable working paper and its current revision   |
| Published revision | `/papers/{short_id}/v{revision}` | One immutable paper revision                     |

Do not add `prodxiv:` to URL paths. It may appear in human-readable identifiers
and citations. A paper receives its public short identifier only on publication;
its UUID remains the draft identity and internal publication provenance.

After publication, an old draft link should resolve to the concrete published
revision through the saved UUID-to-publication mapping. This needs API support;
the current draft endpoint alone cannot provide the redirect after removing
mutable source. Do not revive `/v1/drafts/latest` or use a global latest-draft
alias. Draft history remains bounded to five retained snapshots per paper;
published revision history remains immutable.

## Current implementation and required follow-ups

This document records a future public experience. The operational behavior in
[DRAFTS.md](../../DRAFTS.md), [PUBLISHING_API.md](../../PUBLISHING_API.md), and the
current contracts still applies. This PR does not change the database, API,
generated client, website routes, authentication, or deployment configuration.

### Public draft read boundary

Today all draft API reads require authorization, and the website draft pages
use HTTP Basic authentication. Current management responses can contain review
actors and rejection details. Do not make them public by simply removing an
authentication check or forwarding the full privileged response to a browser.

Implement a deliberately limited public read projection in the Axum API, with
generated OpenAPI and TypeScript contracts. It needs safe listing metadata and
reader content for the publicly readable draft state. Current list responses
do not contain the titles and summaries required by this design. Handle
incomplete or malformed draft metadata without inventing publication readiness.

Keep write authorization, revision checks, ownership rules, and audit records
authoritative in the API. Reviewer identity, rejection notes, private scan
manifests, evidence bundles, source snapshots, model conversations, audit logs,
and `final.zip` are not part of the public read projection. Safe writer/model/
tool-version metadata is distinct from private run data.

Before enabling public reads, explicitly settle how existing private drafts,
approved or rejected drafts, deleted drafts, and retained historical snapshots
are exposed or withheld. The prototype only depicts current pending drafts; it
does not authorize bulk exposure of existing private content or decide those
availability policies. Account redesign remains deferred.

### Archive and revision discovery

The existing public paper collection provides latest-revision summaries with
cursor pagination; it does not yet provide archive-wide search or topic query
parameters. Exact-revision reads already provide the archived source and
metadata, but a revision picker and “newer revision” notice need authoritative
revision discovery. Do not infer available revisions from fixture arrays or
probe every possible version in the browser.

Keep these contracts in Rust and generate the website types. Do not introduce
parallel hand-written paper models or a separate search service for this work.

### Delivery order

1. Define the safe public draft read contract and rollout policy. Add anonymous
   read tests, restricted-write tests, malformed-source cases, and publication
   mapping resolution. Preserve all current review and ownership guarantees.
2. Implement the public archive shell, pending list, and shared reader in Astro,
   using the generated client and existing Markdown renderer. Keep authenticated
   review routes working and connect citations/source to exact revisions.
3. Add archive-wide discovery and revision-history support, then connect the
   search, topic, and revision controls. Until supported, do not present local
   page filtering or guessed revision history as real archive features.

## Acceptance checks for implementation

- Anonymous readers can distinguish and open a published paper and an eligible
  pending draft. Restricted operations still require the right principal.
- An author edit cannot be automatically approved by the bot, even if it races
  with a scheduler run; stale revision actions fail visibly.
- A direct draft link carries the same unpublished/ownership warning as the
  list flow. A publication handoff resolves to an exact short-ID revision.
- Selecting an older published revision changes the title, metadata, body,
  citation, and raw source together; historical content is never rewritten.
- Empty archive, empty queue, no search matches, unavailable content, and API
  failures have distinct, honest states. A failure is not shown as an empty
  successful result.
- Keyboard navigation, dialogs, section links, and back-to-list flows work.
  Test light/dark appearance and widths of 320px, 360px, and 736px without
  horizontal overflow or hidden primary navigation.
- Public output contains only intended paper content and safe provenance, never
  credentials, internal review data, or private run archives.

The wireframes illustrate the primary reading flows, not every acceptance
state. Production error handling, complete Markdown rendering, real pagination,
backend access controls, accounts, and deployment are not implemented here.
