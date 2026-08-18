# Draft papers

Drafts are private, mutable working copies of unpublished papers. A draft is
identified by a UUID from its first save. Publication identifiers such as
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

All draft routes require either the author publishing token or the dedicated
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

## Author review

The private website route `/drafts` lists drafts by review state. In the MVP it
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
