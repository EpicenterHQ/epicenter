# 0438. Hosted blobs have stable authority URLs

- **Status:** Proposed
- **Date:** 2026-09-23
- **Implemented portion (2026-09-23):** Personal authority routes publish, read, and delete owner-level URLs. An Account-bound TypeScript client provides `publishPrivate`, `publishPublic`, `download`, and `delete`. Both server deployments mount the routes.
- **Unbuilt:** Shared owner authorization and routes, URL references in application rows, and owner-wide erasure.
- **Amends:** [ADR-0154](0154-blob-access-is-address-only.md) at hosted addressing: callers retain authority URLs instead of supplying a separate BlobId and store namespace; remote access remains address-only. [ADR-0372](0372-local-and-remote-blobs-open-independently.md) at hosted ownership: Local stores lend `.blobs`, while hosted blobs belong to a captured Account rather than a structured store definition. [ADR-0423](0423-app-resources-open-as-independent-handles.md) at hosted lifecycle: Account retirement fences hosted traffic, while workflow cancellation belongs to its caller. [ADR-0426](0426-copies-create-independent-blobs-at-their-destination.md) at hosted result shape: each publication returns a fresh URL rather than a store-relative BlobId. [ADR-0427](0427-opening-a-blob-acquires-presentation-without-retaining-a-copy.md) at hosted presentation: an authority URL is fetched as bytes, without a required remote `open` transport.

## Context

Before this cutover, `openPersonal(definition, { account })` acquired `personal.blobs` under the
definition ID and principal. `add` or `copyFrom` returns a BlobId, and a row
resolves it through the containing store. A private HTML media element cannot
send the Account bearer, so remote `open` uses a page and service worker to
relay authenticated byte ranges. That store-scoped transport is retired.

A published file can instead be an immutable hosted object with one address.
The application may save that address in a row, fetch private bytes with its
captured Account, or place a public address directly in a media element. A
captured Account supplies authentication and one Personal owner. A structured
store definition does not participate in the object's identity or lifetime.

## Decision

**Each hosted blob is an immutable object named by a stable URL on its authority.**

The publishing authority allocates a fresh opaque key and returns a complete
HTTPS URL after the bytes are published. Local development may use an HTTP
loopback authority. That URL is the durable reference in an application row.
It contains no credential or temporary presentation grant.
The storage backend and physical key are deployment details; a Cloudflare
R2 URL is not saved in the row. There is no second public FileId for the hosted
object. A new publication, including a copy of identical bytes, gets a new URL.
The authority never replaces the bytes at an occupied URL or deliberately
reissues a deleted URL. Keys come from a cryptographically random space, and
publication uses a create-only storage write. This gives practical
nonreuse without a tombstone catalog. Deleting the object can make a saved URL
unavailable.

Every object has one fixed owner: a personal principal or a space on that
authority. It also has one fixed read visibility: private or public. The owner
and visibility are bound to the URL by the authority. The URL shape distinguishes
public from private so a reader can choose direct media playback or an
authenticated download after loading an ordinary row string. The complete URL
is the file identity; its key is only an opaque path segment. The server
enforces the actual policy.
A common URL parser exposes the owner and public or private distinction to
applications without granting access. A public object still has an owner who
controls deletion. Changing owner or visibility publishes another object and
returns another URL; it does not retarget existing references.

**The canonical URL path fixes owner and visibility and determines the storage
key.** The proposed authority paths are
`/api/blobs/personal/{principalId}/{private|public}/{key}` and
`/api/blobs/spaces/{spaceId}/{private|public}/{key}`. Owner IDs use the
authority's URL-safe `[A-Za-z0-9_-]{1,64}` grammar as literal path segments.
The server allocates each key from 128 random bits and encodes it as 22
unpadded base64url characters, with no file extension. The parser accepts
only a complete URL on a trusted authority with that exact path,
and rejects credentials, query, fragment, alternate encodings, dot segments,
encoded separators, and other same-origin paths. Private callers use their
captured Account to select the authority; public callers can use trusted
authority configuration without signing in. The server applies the same
canonical grammar before deriving a physical key. The physical object key
follows the same owner and visibility segments. The server can authorize a
request and an operator can sweep one owner's objects without a policy database
or user-facing listing.
The owner segment is the literal `principalId` or `spaceId`, not a secret alias
or a second owner identity. An authority must use this grammar when issuing
owner IDs that can publish hosted blobs.
Two public URLs with the same owner segment can be linked across applications.
Once one URL identifies a person or space, other encountered URLs with that
segment reveal the same owner. A self-hosted operator can choose a meaningful
principal ID, so the segment can expose a name directly. The object key remains
unguessable; knowing the owner segment grants neither listing nor private read.

**The captured Account fixes the Personal owner; the method fixes visibility.**
`createPersonalHostedBlobs(account)` exposes `publishPrivate(bytes: Blob)` and
`publishPublic(bytes: Blob)`, each returning a fresh authority URL on success.
It also exposes `download(url)` for authenticated byte reads and `delete(url)`
for a known object belonging to that Personal owner. The server checks current
permission on every request. `File` is a `Blob` input. A caller cannot supply
the key or publishing owner. The server does not delete rows that cite an object.

`local.blobs` remains a store-borrowed `LocalBlobs` capability over device-local
BlobIds. Hosted access is independent of `openPersonal(definition)`: opening or
closing a Yjs store neither opens nor closes the Account-bound blob client.
Account retirement fences its requests. A workflow that needs publication to
stop when its row destination closes passes its own abort signal and retains a
known URL when its row write fails. The hosted client does not expose the old
store-relative `add`, `copyFrom`, or `open(blobId)` operations, nor a user-facing
`list` or `stat`. Public URLs can be read directly; private reads use the
captured Account.

A future space owner needs its own Account-authorized owner binding and server
membership policy. `openShared` need not exist just to publish bytes. Its client
constructor waits for that policy; this record adds no Shared route or facade.

Publication accepts supplied Blob bytes and has an explicit server-enforced
size bound; accepting a `Blob` does not promise arbitrary-size uploads. It
does not promise a Local BlobId source overload or native Local-to-hosted
streaming. A later large-media caller
must establish that transfer requirement explicitly; reading a native Local
recording completely into a WebView Blob is not an implicit substitute.

For example, Alice publishes supplied bytes with
`createPersonalHostedBlobs(account).publishPrivate`, then publishes a separate
copy through a future space-owner capability. The resulting URLs identify
independent objects. The space URL can go directly into a media element when
its bytes have a safe media type; the Personal URL requires Alice's captured
Account to fetch it. Publishing and deleting never enumerate the owner's other
objects. The Personal client methods and authority routes are current exports;
the space-owner capability remains proposed.

| Request | Server rule |
| --- | --- |
| Read a public URL | Permit GET and HEAD without a session. |
| Read a private personal URL | Require an Account for the named principal. |
| Read a private space URL | Require an Account whose principal is a current member of the named space. |
| Publish or delete under a personal or space owner | Check that owner's write permission separately from read visibility. |

Publication posts bytes to the captured owner's private or public collection
path and returns the canonical object URL only after create-only storage
succeeds. Deletion sends `DELETE` to that exact object URL. A read or delete
never changes the URL's owner or visibility. The server admits a public GET or
HEAD without Account auth, while every private read and every write checks a
current grant. Space membership and space write permission are distinct server
decisions; they are not inferred from a Yjs row.

The server refuses an unknown URL or owner. Lack of a matching personal or
space grant never makes an object public. Space membership is server-owned
state, not an app-editable Yjs field. A later membership change
affects later requests, but cannot retract bytes already delivered. The fixed
owner bound to the URL prevents signing into another account from reinterpreting a
saved reference. `Account.fetch` uses the Account captured for that authority;
an Account for another authority cannot redeem its private URL.

Application rows contain ordinary URL strings. They do not publish bytes, grant
access, transfer ownership, or delete objects when the row disappears. Local
capture can continue using a device-local BlobId. An application that
publishes bytes from any source creates a hosted URL independently of that
source. Saving that URL in Yjs is a separate write. A workflow retains
a known published URL when its row write fails, so retrying the row does not
upload again. A lost publication response may leave an object whose URL the
caller does not know; no exactly-once or cross-storage transaction is claimed.

**Hosted blobs have no user-facing inventory or parent-URL listing.** The
server's storage enumeration remains an internal deployment operation. Rows,
documents, and other saved citations are how a person finds a hosted URL. If
the last citation disappears, the object can remain stored but unreachable
through the application. No reference-liveness index or automatic reclaim pass
is required. Explicit blob deletion can break saved citations.

## Consequences

Structured stores retain their Yjs and local SQL lifetimes. Closing one does
not fence Account-bound hosted traffic or delete published objects. Account
retirement fences its network requests. Opening another definition for the same
Personal or Shared owner reaches the same hosted objects by URL; the definition
ID is not part of hosted identity.
Local blob and recorder storage keep their device-local ownership. A Personal or
Shared store may persist a local replica of its Yjs data, but that replica does
not contain its hosted bytes or imply an offline copy of every cited URL.

An authority URL says where bytes can be requested, not who may read them.
Private applications use their captured Account to fetch complete bytes;
public URLs for safe media can be used directly in HTML media elements. The
server admits only an explicit set of inert media types for inline public
responses and serves other types as attachments. It retains `nosniff` and
sandbox response protection so untrusted content cannot gain script authority
on the API origin. [Local Chrome verification](../reports/20260924-personal-hosted-blob-real-storage-verification.md)
confirmed public WAV playback with those response headers; deployed Worker and
R2 playback remain unverified. The server, including the self-hosted server,
enforces the same owner and visibility rules. A public
response or a previously downloaded private response may remain in someone
else's possession after deletion.

A working copy that contains a URL contains a reference, not the bytes. Pull
and Push do not infer blob deletion from a missing row or file. Transferring
bytes to another owner requires a new hosted publication and an
application-owned citation update. Private reads use a captured Account for the
URL's authority; they need not open the publishing owner's blob handle.

Deleting an account eventually removes its Personal objects; deleting a space
eventually removes that space's objects. Those owner-wide operations use
internal prefix enumeration after new writes are fenced and in-flight uploads
are drained. Deleting one space member's account does not remove the space's
objects. Deleted principal and space IDs cannot be reassigned while old URLs or
objects could remain; otherwise a new owner could inherit their authority.
This does not expose an owner inventory to applications. Until that
deletion coordinator exists, the platform does not claim complete owner erasure.

The complete URL also fixes the authority origin and route spelling. Moving
the physical storage behind that origin does not change citations, but requires
the operator to migrate the stored bytes and metadata first. Moving
the origin, renaming an owner ID, or changing the route requires keeping the old
endpoint serving or publishing new objects and updating citations explicitly.
Private `Account.fetch` does not follow a URL to another origin, and there is
no citation catalog that could guarantee a complete rewrite.

## Considered alternatives

- Keep hosted object identity under each structured store: makes the definition
  and containing row scope necessary to resolve an otherwise independent object.
- Lend hosted `.blobs` from each structured store: couples owner-level bytes to
  an unrelated definition ID and store-close lifetime. A thin workflow wrapper
  may add the store's abort signal where that cancellation is actually needed.
- Give Local and hosted `.blobs` the same BlobId operations: makes a hosted URL
  look store-relative again and retains remote presentation machinery without
  a current caller requiring it.
- Use one hosted handle with `owner` and `visibility` on every publication:
  repeats the owner's identity and obscures the two read policies at call sites.
- Add an organization layer beside spaces: creates two shared-owner concepts
  without a distinct membership or administration requirement. A space is the
  shared owner described in [ADR-0419](0419-stores-open-for-explicit-owners-and-compose-live-projections.md).
- Maintain an owner-level file catalog: keeps rowless objects findable but adds
  naming, listing, retention, and recovery promises not required here.
- Let a parent URL enumerate objects: turns internal storage listing into a
  public inventory and recreates the same catalog promise.
- Hide owner IDs behind public aliases: still links one owner's public files
  and adds an owner mapping. Per-object unlinkability would require an owner
  lookup for every URL.
- Treat an unguessable URL as read permission: anyone with a private row value
  could read its bytes without the owner's Account or space membership.
- Use a content hash as the URL key: exposes byte equality across owners and
  makes independent copies share an address and deletion lifetime.
- Require native Local-to-hosted streaming in the initial hosted API: Whispering's
  former Save to Personal audio path was retired. No current product caller
  justifies retaining a second transfer transport.
