# 0226. A host serves bundles and brokers credentials; it owns no application data

- **Status:** Accepted
- **Amended by:** [ADR-0273](0273-an-epicenter-app-is-an-spa-with-a-namespace-and-background-work-is-a-hidden-window.md) at what the host brokers: an application's own third-party secrets, several per application, and one OAuth callback route the host owns so no application registers one.
- **Amended by:** [ADR-0271](0271-a-workspace-mirrors-continuously-to-the-epicenter-folder-one-way.md) at what a host may hold, on this record's own reasoning: the refusal is of a second convergent plane, and a one-way mirror cannot diverge, so the host may write rendered files exactly as it already holds blob bytes.
- **Amended by:** [ADR-0393](0393-rows-refer-to-blobs-without-owning-their-lifetime.md) withdraws reliance on ADR-0205's unfinished-capture recovery promise. Progressive native file storage and avoiding whole-file WebView transfers still stand; the host does not become a second application-data authority.
- **Date:** 2026-08-08
- **Amended by:** [ADR-0323](0323-background-work-runs-in-the-host-and-a-window-is-for-looking-at.md) at what a host does. It serves bundles, brokers credentials, and now runs a declared slice of first-party application code, because a hidden window cannot stay awake and the host already owns the files and the credentials that work needs. The refusal this record was written for is untouched: nothing there opens a store or serves an authority.
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Amends:** [ADR-0209](0209-epicenter-is-the-raw-view-beside-its-applications-not-a-shell-above-them.md)
  and [ADR-0208](0208-every-app-folder-is-markdown-beside-one-queryable-database.md),
  at one bounded point each. Both read the HOST REPLICA (the raw view and the
  folder projector each opened `source.replicaPath`), and an application on the
  new store does not write there. Both are now deleted along with that replica. Withdrawn: that the raw view and the queryable projection can see an
  application's live rows. What survives unchanged is everything else in both,
  including every application still on the superseded stack, and the shape of
  the answer: a reader that wants an application's rows becomes a replica of
  the authority that application uses.
- **Relates:** [ADR-0225](0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md)
  (the one authority a surface reaches),
  [ADR-0190](0190-a-build-declares-which-epicenter-owns-its-data-not-which-window-it-runs-in.md)
  (which this narrows: a build no longer declares that at all),
  [ADR-0177](0177-a-browser-replica-is-owned-by-a-storage-partition-and-origin-pair.md).

> **2026-09-05 note:** the quotation from `packages/blobs/src/blob-store.ts` below,
> calling a blob content-addressed, is stale: ids are minted rather than hashed
> ([ADR-0148](0148-blobs-use-opaque-identifiers-rather-than-content-hashes.md)).
> The reasoning it supports is untouched, because a minted id still names
> write-once bytes that cannot diverge, and [ADR-0349](0349-local-blobs-belong-to-the-app-on-this-device.md)
> keeps desktop blob bytes on the host filesystem on exactly that reasoning.

## Context

The desktop host owns a Bun process, so `openBunStore` runs there, and a served
window could have been a replica of a store the host owned. The superseded stack
did exactly that: Honeycrisp's host-served build opened the host's
`epicenter.sqlite3` so Home's tools could read its notes.

Rebuilding it on the new store was already half designed. It needed the host to
serve an authority, which is a second deployment of ADR-0225's route, plus a
second transport topology, plus an answer for what happens when the host's
authority and Cloud's disagree about the same document.

## Decision

**Refused. A host serves bundles and brokers credentials, and owns no
application data.** Every surface opens its own store and reaches one authority
per account.

The refusal is worth taking because of what the alternative buys: two windows on
one machine already converge, through the same authority every other device
uses. The machine-local authority would only make a convergence that already
happens happen SOONER, and the price is a whole second data plane with its own
failure modes.

`#platform/application` is deleted rather than collapsed to one leaf. "Am I the
build the desktop host serves" is now a question with no consequence for
storage, so there is nothing for the seam to select. `#platform/auth` stays,
because the host really does broker a credential its windows cannot obtain, and
that is the difference between the builds that survives.

## What "data" means here, and what it does not

The title says "application data" and the reasoning above is entirely about
CONVERGENCE: a second authority, a second plane, and the failure modes of two
copies that can disagree. Those are the same thing for rows and documents, and
they are not the same thing for blobs. Stating the difference, because the title
alone would decide it the other way.

**A blob is not CRDT-backed and cannot diverge.** It is content-addressed and
write-once (`packages/blobs/src/blob-store.ts`: "The id already names immutable
local bytes and cannot be overwritten"). There is no merge, no last-writer-wins,
and no pair of copies that can disagree, so a blob on the host creates none of
the failure modes this record refuses. The refusal is of a second CONVERGENT
plane, not of the host holding bytes.

**A blob's durable home is the remote object store, not the host and not the
page.** The host holds local bytes; some of them are uploaded and some are
queued, and the row says which (`uploadedAt` is null until an upload succeeds).

**When a blob uploads is the application's policy, and Epicenter supplies only
the verbs.** Whispering already treats it that way: `recording.autoUpload` is a
setting, and an upload is an explicit act rather than something the platform
does on a schedule of its own. Epicenter has no opinion about batching, Wi-Fi,
retention or ordering, and should not grow one; an application that wants to
hold everything locally forever is making a choice this layer does not overrule.

**Moving audio into the page would buy nothing it appears to buy.** A page's
IndexedDB is no more durable than the host's filesystem, no more portable, and
no more synced, because blobs reach other devices through the object store
either way (ADR-0089/0091). It would cost the Rust progressive writer, which
needs a filesystem, and with it ADR-0205's "a recording is a row that fills and
a crash finishes it"; it would put multi-hour captures in IndexedDB; and it
would route every upload through WebView IPC instead of streaming. That is a
capability regression bought to make one word in a title true.

**The asymmetry worth knowing:** a blob that has not uploaded exists on exactly
one machine. A row survives a dead laptop through the authority; un-uploaded
audio does not. That is true under either arrangement, and it is the real
durability question hiding behind the tidiness one. The blob plane does not have
the row plane's guarantees and should not be assumed to.

## Consequences

Two surfaces on one machine with no network stay apart until one reconnects.
Each is complete on its own meanwhile, because each holds the whole document
(ADR-0215); what is unavailable is the other surface's newest writes, not the
data.

**Home's cross-application tools no longer read a live application's rows**, and
this is the real cost. It is bigger than one sentence, which is why it is an
amendment above rather than a note here. Two shipped surfaces read the host
replica and would show a migrated application nothing:

- ADR-0209's raw view and the Data pane over it (`/api/home/inspect`), deleted.
- ADR-0208's queryable projection beside an app's markdown
  (`~/Epicenter/<namespace>/<app>.sqlite3`), deleted with the renderer beside it.

A reader that wants an application's rows becomes a replica of the authority
that application uses, which is the shape every other reader already has rather
than a privileged local one. Nothing in this decision says how the host does
that, and until it does, a migrated application is invisible to both surfaces.

That is the strongest argument for reopening this, and it is stronger than the
offline case below.

ADR-0190 is narrowed rather than superseded. Its rule was that a build declares
which Epicenter owns its data rather than detecting a window at runtime; the
rule stands and now has nothing to declare, because the answer is the same for
every build.

The offline-sharing case is the one thing that could reopen this. It is a real
scenario (a laptop with two Epicenter surfaces open on a plane), and if it ever
matters more than the second data plane costs, the shape to build is ADR-0225's
route served by the host, not a bespoke local arrangement.
