# Draft papers

Drafts are mutable working copies of unpublished papers. Management is private;
deployments may explicitly enable public reading of current pending drafts.
A draft is identified by a UUID from its first save. Publication identifiers such as
`2608.000001` are allocated only when a paper is published.

Draft source may be incomplete Markdown, but it must be non-empty and at most
2 MiB. Saving a draft does not imply that it passes the publication schema,
has been reviewed, or is eligible to publish. The publishing API remains
responsible for authoritative validation.

Each current draft has one review state:

- `pending_review` is the default for a new draft or edited revision;
- `approved` authorizes one exact revision for publication by a later run;
- `rejected` keeps the revision private and may include a reason.

Review decisions are revision-bound. Uploading an edit creates the next draft
revision and returns the draft to `pending_review`; it never changes an older
snapshot or carries an approval forward.

Each draft also has one current `owner_kind`: `author` or `bot`. The API derives
ownership from the authenticated principal rather than trusting request JSON.
A draft created by the daily scheduler starts bot-owned. An edit authenticated
as the author transfers it permanently to author ownership; later bot
mutation attempts are rejected and cannot transfer it back. Creator and
revision provenance remain in the audit log independently of current
ownership.

## HTTP resources

All management routes below require either the author publishing token or the dedicated
bot identity. The production scheduler presents a short-lived GitHub Actions
OIDC token; a distinct static bot token remains available for local operation
and rollback. There is deliberately no `/v1/drafts/latest` alias; clients
discover recently edited drafts from the collection and then use a concrete
UUID.

```text
POST   /v1/drafts
GET    /v1/drafts
GET    /v1/drafts/{paper_uuid}
PUT    /v1/drafts/{paper_uuid}
POST   /v1/drafts/{paper_uuid}/approve
POST   /v1/drafts/{paper_uuid}/approve-and-publish
POST   /v1/drafts/{paper_uuid}/reject
DELETE /v1/drafts/{paper_uuid}
POST   /v1/drafts/{paper_uuid}/publish
GET    /v1/drafts/{paper_uuid}/revisions
GET    /v1/drafts/{paper_uuid}/revisions/{revision}
```

`GET /v1/drafts` orders results by `updated_at` descending. Current-draft
responses include an `ETag` containing the quoted revision number. The
collection accepts `review_status=pending_review|approved|rejected` and
`owner_kind=author|bot`. `PUT`, review actions, `DELETE`, and publication
require the current revision in `If-Match`, preventing a stale editor or
scheduler from acting on another save.

Creating a draft also requires an `Idempotency-Key` between 8 and 128
characters. The same actor may safely retry the same key and exact Markdown;
the first request returns `201 Created` and a replay returns `200 OK`. Reusing
the key for different Markdown returns `409 Conflict`.

## Public reading

The public website uses a separate read-only API, never the management responses:

```text
GET /v1/public/drafts
GET /v1/public/drafts/{paper_uuid}
```

Set `PRODXIV_PUBLIC_DRAFTS_ENABLED=true` on the **API project** to opt in. It is
off by default; disabled reads return `503` with `draft.public_reads_disabled`.
Before enabling it, check that every current pending draft's source and metadata
may be public. Enabling this setting includes existing pending drafts, including
author-owned drafts, and subsequent pending revisions. It does not automatically
approve or publish anything and does not grant write access.

The collection returns current `pending_review` drafts ordered by most recently
edited, with `limit` and a `next_cursor` for pagination. Public summaries contain
the UUID, revision, ownership, pending status, update time, and optional parsed
paper metadata. A malformed or incomplete draft can have no metadata and remains
readable with a clear warning; saving or displaying it is not publication
validation. Reviewer identity, rejection reasons, retained draft snapshots,
private run archives, conversations, and audit logs are excluded.

The concrete UUID route returns either `kind: "draft"` with the current pending
draft and source, or `kind: "published"` with the exact `paper_id` and `version`
from the publication mapping. The website redirects the latter to the immutable
short-ID reader. Approved, rejected, deleted, and unknown drafts do not expose
source through this endpoint and return the same `404` behavior. Public draft
responses use `Cache-Control: no-store`; the website also excludes mutable draft
pages from indexing. Rejection cannot retract copies a reader already saved.

`/drafts` and `/drafts/{paper_uuid}` are now public reading routes. They do not
accept review writes. Use the separate author workspace for all review actions.

## Author review

The private website route `/review/drafts` lists drafts by review state. In the MVP it
uses browser HTTP Basic authentication: enter any non-empty username and use
the publishing bearer token as the password. The website forwards that token
from the server request and does not put it in client JavaScript or its runtime
configuration. This shared token records the configured publishing actor, not
an individual reviewer identity; replace it with user authentication before
opening review to multiple authors.

Approval validates the stored Markdown with the publication profile before
recording the decision:

```http
POST /v1/drafts/{paper_uuid}/approve
Authorization: Bearer ...
If-Match: "3"
```

The review page also offers **Approve and publish now**, which atomically binds
approval to the displayed revision and publishes it. A successful request
redirects to the immutable public paper. Rejection retains the draft and all
snapshots still covered by the normal five-revision retention window. Its
optional JSON body is `{"reason":"..."}`. Editing through the website uploads a
new revision of the same unpublished paper UUID. The review UI deliberately
has no delete action.

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

The exact current revision must already be `approved` when using `/publish`.
The daily Paperbot workflow first publishes approved, unchanged revisions. It
may also use the atomic endpoint below to approve and publish a
`pending_review` revision when that draft is still bot-owned:

```http
POST /v1/drafts/{paper_uuid}/approve-and-publish
Authorization: Bearer ...
If-Match: "3"
Idempotency-Key: stable-approval-publication-key
Content-Type: application/json

{}
```

The combined operation is atomic: validation, approval audit, immutable
publication, UUID provenance, and mutable-draft removal either all commit or
all fail. The author principal may use it for any current draft. The bot
principal may use it only for a pending bot-owned draft. The workflow performs
promotion before creating the day's new drafts, so a new suggestion remains
available for review until at least the next run. A human edit transfers
ownership to the author and makes bot auto-approval fail even if the scheduler
already listed the draft.

The first successful request returns `201 Created` and the immutable paper.
Retrying the same request with the same idempotency key returns that paper with
`200 OK`, even though the mutable draft content has already been removed. A
conflicting reuse of the key returns `409 Conflict`. Validation failures return
`422 Unprocessable Entity` and leave the draft available for revision.
The daily scheduler records those structured diagnostics. It rejects and
retains an unpublishable pending bot-owned draft so it cannot block the active
queue forever; an invalid author-approved draft remains approved and available
for author correction.

The Paperbot model and drafting process never receive an API credential. The
host scheduler alone requests a short-lived GitHub Actions identity and
performs remote writes. The API maps only the exact daily Paperbot workflow to
the bot principal. It may publish an author-approved exact revision, but it
cannot approve an author-owned revision.

## Retention and audit

Every successful save creates a monotonically increasing draft revision. The
service retains the five newest content snapshots for each draft. Creating a
sixth retained snapshot removes the oldest content snapshot; the append-only
audit event remains.

Rejecting or rotating a draft never deletes it. `DELETE` is a distinct
administrative/privacy operation: it removes current source and retained
content snapshots. Its deletion audit event remains and contains the UUID and
last revision, but not the source Markdown.

Published revisions have different durability: they use the allocated short
paper identifier and are immutable. Successful publication removes the mutable
draft and its retained snapshots while preserving an immutable internal mapping
from the originating UUID and draft revision to the published paper. Public
URLs and responses use the allocated short identifier, not the UUID.
