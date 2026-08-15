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
POST   /v1/drafts/{paper_uuid}/publish
GET    /v1/drafts/{paper_uuid}/revisions
GET    /v1/drafts/{paper_uuid}/revisions/{revision}
```

`GET /v1/drafts` orders results by `updated_at` descending. Current-draft
responses include an `ETag` containing the quoted revision number. `PUT` and
`DELETE` require that value in `If-Match`, preventing one editor from silently
overwriting a newer save.

## Publication handoff

Publishing is an explicit operation on one saved draft revision:

```http
POST /v1/drafts/{paper_uuid}/publish
Authorization: Bearer ...
If-Match: "3"
Idempotency-Key: stable-publication-key
Content-Type: application/json

{}
```

The optional request field `product_id` associates the paper with an existing
product. Source Markdown is deliberately absent from this request: the service
locks and publishes the exact saved revision named by `If-Match`.

The first successful request returns `201 Created` and the immutable paper.
Retrying the same request with the same idempotency key returns that paper with
`200 OK`, even though the mutable draft content has already been removed. A
conflicting reuse of the key returns `409 Conflict`. Validation failures return
`422 Unprocessable Entity` and leave the draft available for revision.

Paperbot must not invoke this endpoint automatically. Publication remains a
separate, explicitly authorized author action.

## Retention and audit

Every successful save creates a monotonically increasing draft revision. The
service retains the five newest content snapshots for each draft. Creating a
sixth retained snapshot removes the oldest content snapshot; the append-only
audit event remains.

Deleting a draft removes its current source and retained content snapshots. Its
deletion audit event remains and contains the UUID and last revision, but not
the source Markdown.

Published revisions have different durability: they use the allocated short
paper identifier and are immutable. Successful publication removes the mutable
draft and its retained snapshots while preserving an immutable internal mapping
from the originating UUID and draft revision to the published paper. Public
URLs and responses use the allocated short identifier, not the UUID.
