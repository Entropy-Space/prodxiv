# Draft papers

Drafts are private, mutable working copies of unpublished papers. A draft is
identified by a UUID from its first save. Publication identifiers such as
`2608.000001` are allocated only when a paper is published.

Draft source may be incomplete Markdown, but it must be non-empty and at most
2 MiB. Saving a draft does not imply that it passes the publication schema,
has been reviewed, or is eligible to publish. The publishing API remains
responsible for authoritative validation.

## HTTP resources

All draft routes require the configured bearer token. There is deliberately no
`/v1/drafts/latest` alias; clients discover recently edited drafts from the
collection and then use a concrete UUID.

```text
POST   /v1/drafts
GET    /v1/drafts
GET    /v1/drafts/{paper_uuid}
PUT    /v1/drafts/{paper_uuid}
DELETE /v1/drafts/{paper_uuid}
GET    /v1/drafts/{paper_uuid}/revisions
GET    /v1/drafts/{paper_uuid}/revisions/{revision}
```

`GET /v1/drafts` orders results by `updated_at` descending. Current-draft
responses include an `ETag` containing the quoted revision number. `PUT` and
`DELETE` require that value in `If-Match`, preventing one editor from silently
overwriting a newer save.

## Retention and audit

Every successful save creates a monotonically increasing draft revision. The
service retains the five newest content snapshots for each draft. Creating a
sixth retained snapshot removes the oldest content snapshot; the append-only
audit event remains.

Deleting a draft removes its current source and retained content snapshots.
Its deletion audit event remains and contains the UUID and last revision, but
not the source Markdown.

Published revisions have different durability: they use the allocated short
paper identifier and are immutable. A later publication handoff will preserve
the originating draft UUID as internal provenance while exposing the short
identifier in published URLs.
