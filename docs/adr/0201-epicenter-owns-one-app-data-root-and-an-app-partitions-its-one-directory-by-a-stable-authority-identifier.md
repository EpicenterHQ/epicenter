# 0201. Epicenter owns one app-data root, and an app partitions its one directory by a stable authority identifier

- **Status:** Accepted at the root and the app directory; the partition levels
  below them are withdrawn. Read the `Amended by` line before building anything
  from the path in this record.
- **Date:** 2026-08-02
- **Amended by:** [ADR-0314](0314-an-app-is-one-directory-and-installation-is-a-rename.md)
  and [ADR-0319](0319-local-mail-is-device-local-and-its-storage-splits-by-lifetime.md)
  at everything below `apps/<app-id>/`. The path stated here,
  `<root>/apps/<app-id>/<kind>/<partition-id>`, is withdrawn: an app directory
  now holds `bundle/`, `data/<data-id>/`, `sqlite/<name>.sqlite`, and `blobs/`
  (ADR-0314), and a partition is a filename rather than a directory
  (`mail-<sub>.sqlite`, ADR-0319). `intent.db` and `mail.db` no longer exist.
  What stands: one application-data root per machine, one directory per trusted
  app named by its id, and the rule that the directory is a place and never an
  inter-app API.
- **Amended by:** [ADR-0349](0349-local-blobs-belong-to-the-app-on-this-device.md) at the open question this record left, "a
  separate question about who tells the recorder where blobs live, and it is not
  decided here": the planned recorder handoff takes `{ appId, principalId }`
  at start and targets `<root>/apps/<app-id>/<principal-id>/blobs/`. For blobs this
  replaces the kind-first `partitionDir` spelling. The root question is not
  otherwise reopened.
- **Amends:** [ADR-0062](0062-local-books-stores-oauth-tokens-in-a-single-0600-file.md) at one clause, the location of the token file, which is now the app directory's root and keeps its `0600` mode and its exclusion from any mirror directory; [ADR-0072](0072-local-books-ships-as-a-standalone-cli-the-daemon-surface-is-deferred.md) at one clause, where a standalone CLI's data lives, leaving its standalone shape and deferred daemon untouched.
- **Completed by:** [ADR-0202](0202-a-provider-account-belongs-to-the-app-whose-durable-state-it-names-and-epicenter-brokers-none.md), which answers the one question this record left open: who owns the provider grant that names a partition. It amends nothing here.
- **Corrected 2026-08-03, before merge, at one clause: which apps "an app" is.** A draft of ADR-0202 narrowed it to a closed set of host-composed engines and gave an admitted app (ADR-0179) no directory at all. That narrowing is withdrawn as a product decision, and the rule is restated below at the width it was always written at: **every trusted app Epicenter runs or admits has one place.** Nothing else in this record moves. Both records are unmerged, so this is an edit to an unlanded decision rather than a rewrite of a governing one.
- **Corrected 2026-08-03, before merge, at one level: `data/` is removed and the replica sits at the root.** The rule this record states is that a level exists exactly where naming authority changes hands, and Epicenter names `data/`, `blobs/`, `app-catalog/`, and `apps/` alike. No hand-off happens at `data/`, so by this record's own test it never earned a level. Removing it also puts `blobs/` beside a *file* rather than beside a folder, which is what makes the spill relationship legible: bytes adjacent to `epicenter.sqlite3` read as belonging to it, where bytes adjacent to a `data/` directory read as a second system. ADR-0172 already drew them as siblings under one storage root; this makes that root the actual root. The most important object in the product stops being hidden inside a folder named after a word that means nothing.
- **Corrected 2026-08-03, before merge, at one word and everything that word was dragging: the host names a place, it does not allocate one.** Allocation is the vocabulary of a resource handed out and taken back, and this record kept the word while spending five lines denying every part of it (no allocation call, no handle, no host verb, nothing created at admission). The id is the only thing here with two possible claimants, and the path is a pure function of it, so naming is not a softer synonym for allocating but the accurate description. Nothing about the shape moves. The denials shrink to the one sentence that gives the reason, and the Decision statement now says what the host actually does.
- **Relates:** [ADR-0203](0203-epicenter-owns-only-what-is-already-contended.md) (the general rule this record is one application of: the id is contended and the directory is not, which is why the host names rather than allocates, and why reach is refused rather than deferred), [ADR-0198](0198-a-durable-local-mail-write-is-a-per-message-label-assertion-in-a-sibling-intent-database.md) (untouched, and deliberately: an intent store's durability is a rule about ordinary operation inside a partition, and this record decides only where the partition is), [ADR-0151](0151-local-workspace-stores-use-owner-first-directories.md) (owner-first directories inside the replica plane; this record governs the plane beside it), [ADR-0161](0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary.md), [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md), [ADR-0181](0181-every-app-receives-one-portable-epicenter-capability-handle.md) (the closed capability namespace, which this record does not widen), [ADR-0183](0183-epicenter-mediates-the-effects-it-owns-and-names-the-rest-unmediated.md), [ADR-0190](0190-a-build-declares-which-epicenter-owns-its-data-not-which-window-it-runs-in.md), [ADR-0196](0196-local-mails-mirror-is-a-reader-and-one-full-message-fetch-is-its-entire-budget.md), [ADR-0197](0197-a-mirrors-corpus-version-names-its-artifact-and-only-the-app-knows-when-one-is-ready.md) (the filename grammar inside a partition; this record decides the directory that grammar is applied in), [ADR-0199](0199-one-account-reconciler-is-local-mails-only-gmail-writer.md) (the one writer, whose delivery is how an intent store empties during ordinary operation inside a partition)
- **Relates, not in this tree:** ADR-0191 (the Epicenter host process owns the mail engine in process) and ADR-0193 (durable authorities and disposable materializations) are on open branches. Where this record depends on one, it says so and restates the borrowed clause rather than linking a file that does not exist here.
- **In force, partly executed.** The root, the app directory, and the single partition directory are code in both apps, and native desktop startup now passes its resolved paths to Bun (amended 2026-09-08). The partition *name* has not changed yet: Local Mail still names one by the account's email address, so the strand-on-rename defect described below is open until the `sub` adoption ships. One clause is unimplemented and this line is where it is admitted.
- **Repriced 2026-08-02, then re-decided as a clean break.** An intermediate draft argued that because ADR-0198's intent store had shipped as code, this record owed the old directory a relocation and the identity change an emptiness gate. That reasoning is withdrawn: Local Mail has no released install, so everything under the pre-record path is local development state, and buying a migration for it costs a code path that outlives its only use. What survives the withdrawal is the *fact* the reprice was built on, which is about the future rather than the past: a partition holds something irreplaceable, so the identifier naming it has to be one the provider promises to keep.
- **Re-challenged 2026-08-02, shape unchanged, argument replaced.** Every level was collapse-tested against the code that had shipped. The shape survived; two of the arguments for it did not. "Listing partitions is a directory read" was false against both apps, which enumerate from their token stores, and `apps/` had never been argued at all. Both are repaired below by the one rule the levels actually follow.

## Context

ADR-0197 settled what a mirror artifact is called and left one input undecided
on purpose: "the caller passes the directory it already computed". Both apps
compute that directory themselves, and each computes a whole OS application-data
<!-- doc-path-check: ignore-next-line -->
root to do it. `apps/local-mail/src/paths.ts` resolves
`~/Library/Application Support/local-mail` from `LOCAL_MAIL_DIR` or the platform
default; `apps/local-books/src/paths.ts` resolves
`~/Library/Application Support/local-books` from `--data-dir`, `LOCAL_BOOKS_DIR`,
or the platform default. Two apps, two roots, two override mechanisms, two
copies of the same platform switch.

ADR-0191 makes that arrangement incoherent rather than merely duplicated. The
Epicenter host process now owns the mail engine in process, so one process holds
both `EPICENTER_DATA_DIR`, which Rust computes from the `so.epicenter` bundle
identity and which already contains `data/`, `blobs/`, and `app-catalog/`, and a
second application-data root that the mail engine computed for itself from the
same platform rules under a different name. A person looking for what Epicenter
stores has to know the list of apps to find it, and uninstalling Epicenter
leaves mailboxes behind under a directory nothing points at.

The partition segment has a separate defect, and it is not a matter of taste.
Local Books names its partition with QuickBooks' `realmId`, which arrives on the
OAuth callback and identifies the company for as long as it exists. Local Mail
names its partition with the account's email address, read from Gmail's
`users.getProfile`. Google documents that response as carrying `emailAddress`,
`messagesTotal`, `threadsTotal`, and `historyId`, and nothing else; it offers no
stable identifier. Google separately documents the OpenID Connect `sub` claim as
"unique among all Google Accounts and never reused", states that "a Google
Account can have multiple email addresses at different points in time, but the
`sub` value is never changed", and instructs callers not to use email as a
unique identifier for a user (verified against Google's `users.getProfile`
reference and OpenID Connect guide, 2026-08-02). A renamed Workspace account
therefore strands its partition and silently begins a second one, and on a
case-insensitive filesystem two spellings of one address are one directory while
on Linux they are two.

Putting both apps' data under one root raises a third question that neither app
has today, because today they cannot find each other. Once `<root>/apps/` exists,
one app is one `join` away from a peer's mailbox, and the two apps already ship
the surface that makes the shortcut tempting: each exposes read-only SQL over its
own mirror, so a generic reader over `<root>/apps/*/**/*.db` looks like a feature
rather than a coupling. Nothing in the corpus decides this. ADR-0181 closes the
capability namespace against a *host* storage service and ADR-0179 governs what
an installed app is, but no record says what one app may do with another app's
bytes. Deciding it after the shared root ships means deciding it against an
existing caller.

The second defect got worse when ADR-0198 and ADR-0199 landed as code. A
partition used to hold nothing but a re-pullable mirror, so stranding one cost
quota. It now also holds `intent.db`, the triage a person recorded and Gmail has
not been told about, which the app's own README calls the only irreplaceable
local state it has. A partition stranded *in service*, by a rename this app
cannot see coming, is therefore a data-loss defect rather than a performance
one, and every argument below that reads "this can be rebuilt" stops at the
intent store's door.

That is a statement about the future, not about the directories on a developer's
machine today. Local Mail has never shipped an install, so there is no mailbox
in the field to carry anywhere, which is what makes the move below a clean break
rather than a migration.

## Decision

**Epicenter owns exactly one application-data root on a machine. It issues one
id to every trusted app it runs or admits, and that id names that app's one
directory below the root. Below that directory the app owns everything, and it
partitions by an identifier the external authority owns and never reuses. The
directory is a place and never an inter-app API: nothing outside the owning app
receives a path into it, and a fact crosses to another app only as a verb the
owner publishes or a fact a person promotes into the shared replica.**

### Why there are exactly these levels

The path is `<root>/apps/<app-id>/<kind>/<partition-id>`, and the rule that
produces it is one sentence: **a directory level exists exactly where naming
authority changes hands, and nowhere else.**

Three parties choose names along that path, in order. Epicenter names the root
and its own directories (`epicenter.sqlite3`, `blobs`, `app-catalog`). An app names
everything in its own directory (`credentials.json`, `provider.json`, a lock
file). An external authority names a partition (`realmId`, Google's `sub`).
Each hand-off gets one segment, because a namespace whose next name is chosen
by somebody else cannot be defended by the party who would have to defend it:
Epicenter cannot promise that a host directory it adds next year misses every
app id, and an app cannot forbid Google from issuing an identifier that spells
`credentials.json`. `apps/` is the first hand-off, the partition-kind directory
is the second, and neither is a container for tidiness.

Every level was challenged by collapsing it and asking what breaks. Collapsing
`apps/` merges Epicenter's namespace with the apps', and takes with it the only
positional statement of the host's promise: *everything under `apps/` is
somebody else's*, which otherwise becomes a list of names to remember.
Collapsing the partition-kind directory merges the app's namespace with a
provider's and buys a reserved-name rule in exchange. Collapsing the partition
level denies that two Gmail accounts are two things. No level is optional, and
none is missing: disposability is not a naming authority,
which is why it lives in ADR-0197's filename grammar and adds no level here.

The rule also decides the questions this record does not have yet. A fourth
authority naming something inside a partition would earn exactly one more
segment; a second directory for the same app, a per-app root, or a `cacheDir`
would earn none, because no hand-off happens at any of them.

### One desktop startup owns its paths

Amended 2026-09-08: native startup owns the desktop's resolved paths. The previous
rule made Bun resolve its own root to match standalone CLIs, while Rust retained
a second resolver for recording. That split failed in development: Rust used
`so.epicenter.dev`, while Bun always used `so.epicenter`. A production-only
comparison test could not establish the runtime invariant.

`DesktopPaths` is resolved and managed once before recorder cleanup or sidecar
launch. Tauri's `app_local_data_dir()` selects the data directory from the running
bundle identifier: Application Support on macOS, absolute `XDG_DATA_HOME` or
`~/.local/share` on Linux, and Local AppData on Windows. `EPICENTER_DATA_DIR`
overrides it. Empty overrides count as unset; relative paths are refused.

The same startup selects the working copy: `~/Epicenter` for `so.epicenter` and
`~/Epicenter Dev` for `so.epicenter.dev`. These are stable destinations, independent
of display names. `EPICENTER_FOLDER_DIR` overrides the destination. An unknown
bundle identifier needs an explicit working-copy directory.

Rust sends required `dataDir` and `folderDir` fields through boot protocol v3.
The recorder reads the managed data directory; Bun uses the received paths.
Sidecar restarts reuse the same directories. No desktop TypeScript resolver,
roaming fallback, or cross-language equality subprocess remains. Tests cover
both configured identities, overrides, and the startup message contract.

Keyring services use the running bundle identifier for both the desktop auth
cell and application secrets. Production addresses remain unchanged; development
starts with its own credentials. Model settings retain Tauri's app-config
location, already scoped by that identifier.

Standalone Local Books retains the TypeScript production-default resolver.
That is CLI convenience, not desktop authority. A CLI targeting development
uses `EPICENTER_DATA_DIR` explicitly. Removing automatic CLI defaults would be a
separate product change. The former `COMPOSED_APP_IDS` reservation list is deleted:
no admission code consumed it. Apps own their identifiers; the shared grammar
continues to validate directory segments.

Windows data previously stored in Roaming AppData is not automatically moved.
The desktop README documents copying it with writers stopped, retaining the old
directory for native settings, or selecting the existing directory explicitly. Development data formerly written by Bun under
the production root is left there; this change neither merges nor deletes it.

### Every app has a directory, and no app receives a storage service

An app's directory is `<root>/apps/<app-id>`, one segment below the hand-off
above, and every trusted app has one. A host-composed engine has one, an
admitted folder of static files (ADR-0179) has one, and a compiled application
has one. Which of them has written anything into it yet is a fact about today,
not a rule: an app's private operational state has one place from the moment the
app exists, and the shared curated replica (ADR-0161) is the other half of what
every app gets, not a substitute for the first half.

The alternative was two classes of app, one with a place and one without, and it
does not survive contact with the question it creates. An admitted app that
later wants durable bytes of its own would have to be promoted into the other
class, which means changing its identity, which means moving or abandoning bytes
it is already storing somewhere worse. Refusing the directory does not refuse the
state; it refuses the *place*, and the state then lands in the one storage the
shared origin already gives every app, where it is neither private nor legible
nor removable with the app. The boundary worth defending is who owns an app's
interior, not whether the app is allowed to have one.

**An app id names a place, so there is one app-id namespace with two issuers.**
Admission issues one when it accepts a folder: the id is the folder name, which
is already the id the host serves the app under (ADR-0179). The composition root
issues one for an engine it composes, as a literal in `@epicenter/constants`,
because a composed engine arrives through no catalog and Local Books has no
launchable surface at all (ADR-0072). Since both issuers name into one space,
admission reserves every id the other issuer has already spent, alongside the
built-in surface ids it already reserves. Two names for one app is ordinary; two
apps for one name is a directory with two claimants, and that is what the
reservation refuses.

The id is deliberately not a surface id. Home's launcher owns surface names and
may rename one; a directory named after it would strand data on a rename. A
surface id is nonetheless reserved against the app-id space for the same
one-namespace reason.

Local Mail is the ordinary case made concrete. `SURFACE_ROUTES` reserves `mail`
and `COMPOSED_APP_IDS` reserves `local-mail`, both so that nothing collides, and
one product therefore holds two ids in the one namespace. That is the normal
case rather than a defect, because the two ids answer different questions: a
surface id names a window, an app id names a place. `apps/mail/` stays
permanently empty while `apps/local-mail/` holds the mailbox, and once the mail
engine is composed behind the `mail` surface (ADR-0191, on an open branch and
not in this tree) the two ids are two facts about one product rather than two
claimants on one directory.

**The host names a place; it does not allocate one.** The path is a pure
function of the root and the id, so issuing the id is the whole of the host's
act. Nothing is created at admission, there is no verb an app invokes to obtain
its directory, and the directory exists exactly when its owner writes into it,
which is the same rule a partition already follows below. An app that never
writes has a place and an empty one, and the host does not know the difference.

Naming is the accurate word rather than a softer synonym for allocating. The id
is the only thing here with two possible claimants, because two apps must not
hold one name; nothing below the name has a second claimant at all, and a
resource with no claimants is not one a host hands out and takes back.

Because ids now reach the path function from an open space rather than a closed
union, `appDataDir` validates the id against the same `[a-z0-9-]+` grammar
admission validates a folder name with, from one shared definition. That is the
one real cost of opening the class, it is a guard rather than a subsystem, and
sharing the grammar is what makes "one namespace" a fact about the code instead
of a claim in this paragraph.

The directory is a string. It is computed where the owner is composed, the way
the Epicenter sidecar already computes `join(root, 'blobs')` in
`apps/epicenter/src/main.ts`, and injected into the engine that needs it. This is the per-concern injection that ADR-0193 requires
for a materialization, and it is why this record adds no capability.

**An admitted app reaches its place by shipping as a runtime, and the host never
closes that distance on its behalf.** A composed engine is handed the string at
its composition root and can open files today. An admitted folder of static files
runs in a webview with no filesystem reach at all, so its place is spoken for and
unwritable from its own code, and it is honest to say so. That gap is not a
question waiting for an app to ask it. It is closed.

What closes it is [ADR-0203](0203-epicenter-owns-only-what-is-already-contended.md)
applied to runtimes: ask whether a per-app runtime is a resource anyone is
already contending for. The answer looks like yes, because the nouns arrive
sounding shared: processes, ports, restart policy, shutdown ordering. None of
them is contended. Local Mail binds its own loopback port from its own process,
and there is exactly one Local Mail. A host that spawned per-app runtimes would
manufacture the port allocation, the supervision, and the lifecycle, and would
then point at them as the reason it had to own them. A mechanism that generates
its own justification is the shape behind every platform this corpus already
refuses.

**An app that needs a runtime ships as a runtime.** Local Mail is the existence
proof, and it reads backwards from the way this gap is usually framed: it has
`src-tauri/`, `src/bin.ts`, and an `src/app.ts` that runs its own `Bun.serve`,
serves its own SPA from `ui/dist`, and injects a per-launch bearer as a
`window.__LOCAL_MAIL__` global. It is not a static folder that acquired a
process; it is a process that serves a folder.

The directory is therefore a name reservation and not a promise of future reach.
An admitted app owns `apps/<id>` in the one sense that matters, that nobody else
can claim it. An app that later needs durable bytes ships as a runtime under the
same id and finds the directory already there and already its own. That is the
no-promotion, no-identity-change argument this record already makes for widening
the rule, and it is stronger as a refusal than as a deferral: a deferred gap is
an invitation to build the bridge.

There is no `epicenter.storage` namespace and no `epicenter.database` namespace.
ADR-0181 already refuses `storage` as an implementation category, and ADR-0193
states the stronger reason for this case: the bytes are not Epicenter's to
offer. That refusal is restated here as still governing, and this record does
not weaken it. Naming a place is not owning a store. The host chooses where
an app's directory is; it never opens, reads, indexes, inspects the schema of,
backs up, or reclaims anything inside it.

There is also no second directory. An app gets one, not a `dataDir` and a
`cacheDir` pair. Disposability is already legible inside the directory, from the
filename, and a second root would say the same thing a second time in a place
that can disagree with the first.

The one directory is data-class, not cache-class, and `intent.db` is why. A
tempting move here is to put a rebuildable store under the OS cache root so that
excluding it from a machine backup is free. A partition is not rebuildable: it
holds a mirror that is and an intent store that is not, side by side, because
they are the same account's state and separating them would put a person's
undelivered triage somewhere their mailbox is not. Cache-class storage on macOS
is a directory the OS may evict under disk pressure, and evicting undelivered
triage is a silent data loss. So the split between disposable and durable lives
inside the partition, in the filename grammar ADR-0197 already defines, and
never in the choice of root.

### An app directory is a place, never an inter-app API

The section above says what the host does not do with an app's directory. This
one says what a peer app does not do with it, and it needs saying separately:
the host is not the only other thing running, and a rule written only against
the host leaves the more likely leak undecided.

**An app receives one string, the path of its own directory. It never receives a
peer's directory, a path below one, an open SQLite handle to a peer's file, or a
connection that reaches one.** There is no directory lookup by app id offered to
app code, no `epicenter.apps.<id>` of any shape, and no host verb that takes an
app id and returns rows. `appDataDir(root, appId)` takes an app id because the
composition root that places every app has to name them all; it is called where
an owner is composed, not from inside app logic that could ask it for somebody
else's directory.

Generic cross-app SQL is the specific thing refused, because it is the one that
looks free. Both apps already expose read-only SQL over their own mirror
<!-- doc-path-check: ignore-next-line -->
(`queryMail` in `apps/local-mail/src/query.ts`, `queryBooks` in
`apps/local-books/src/books/query.ts`). Each is the *owning* app's surface over
the file that app wrote, offered to the person who owns the machine. Widening
either into an engine that takes an app id, or adding a host verb that opens
whichever app's database an argument names, would turn every app's stored shape
into a public schema: the owner could no longer bump a corpus version, drop a
column, or rebuild an artifact without breaking a reader it never agreed to
have. A materialization exists in order to be rebuilt at its owner's discretion,
and one that peers read directly is not that. This is also why the refusal is
not softened by "read-only": the hazard is the coupling, not the mutation.

Cross-app use has exactly two forms, and both are already built:

- **The owning app publishes a verb.** A narrow capability or read model, in the
  owner's own vocabulary, over data the owner interprets. Local Books' `query`,
  `report`, `status`, and `recategorize` cores in `apps/local-books/src/books/`
  are this shape, and its `mcp` verb (ADR-0073) is the same cores re-exposed to
  a foreign caller without a rewrite; Local Mail's read models behind
<!-- doc-path-check: ignore-next-line -->
  `apps/local-mail/src/http/api.ts` are the same. A caller gets projected rows
  with a meaning the owner promises to keep, not a file whose layout it must
  reverse-engineer. What a verb hands back is data, never a location: paths are
  for the person at the keyboard, so `MailStatus.dataDir`, `.tokenFile`, and
  `.mirrorPath` are legitimate in a CLI's own output to its own user and do not
  travel across an app boundary.
- **A person promotes a durable fact into the shared Epicenter.** The one
  replica (ADR-0161), reached through `epicenter.data` (ADR-0181), holds
  intentionally curated portable facts and is schemaless by construction, so
  facts that belong to more than one app go there by an act of curation rather
  than by one app reading another's disk. Promotion is deliberate and lossy on
  purpose: a mailbox does not become shared data because it exists.

This boundary is an API rule between admitted first-party code, and stating that
plainly is what keeps it from growing a mechanism. It is not a filesystem
sandbox and must not be mistaken for one. Every app here runs as the person who
owns the machine, reads what that person can read, and can be pointed at any
file by that person on purpose: handing a mirror artifact to a coding agent is a
documented thing to do with Local Books. The mode bits on a partition are there
to keep *other users and other processes on the machine* out (ADR-0062), not to
adjudicate between two Epicenter apps. So there is no grant, no permission
prompt, no capability token for a directory, and no per-app storage policy to
configure; there is a rule, one owner per directory, and code review.

### A partition is named by an identifier the authority owns

A partition holds everything scoped to one external account, company, or
tenancy. Its directory name is an identifier issued by that external authority,
stable for the life of the thing it names, and never reused. A display name is
not one, whatever the provider calls it.

Local Books already satisfies this with `realmId`. Local Mail does not, and
adopts Google's `sub`, which costs one added `openid` scope and therefore one
re-consent per connected account. That cost is the decision: an identifier the
provider guarantees is worth a consent screen, and there is no local substitute.
Minting a local id and keeping a map from it to the account would put the
account's identity in a file that can be lost, which is the shape ADR-0151
already rejected for account directories. That rejection got sharper with
`intent.db`. Local Mail's account index is `credentials.json`, whose loss already
costs the refresh token and forces a reconnect; under email-named partitions the
reconnect finds the same directory again, because the email is recomputable from
Gmail's profile. Under a minted id it does not, and what it fails to find now
contains undelivered triage. A locally minted identifier turns a recoverable
credential loss into a data loss.

The segment is validated as exactly one path component before it names a
directory. Local Mail already does this; Local Books does not, and takes
`realmId` verbatim from a callback query parameter into `join(dataDir, realmId)`
(`apps/local-books/src/oauth.ts`, `apps/local-books/src/paths.ts`). Two call
sites, one of them currently unguarded, is what earns one shared guard.

### The path change is a clean break, in both apps and both directions

This record changes a partition's path twice: once when the app directory moves
under the one root, and once when the segment naming the account becomes the
identifier Google issues. Neither carries anything forward. Nothing reads a
pre-record path, nothing moves a directory, nothing copies a database, and there
is no migration code in either app to keep correct after the release that ships
it.

The reason is a fact about this product rather than a preference: **neither app
has a released install.** Every directory under a pre-record path is local
development state, and paying for a relocation buys a person nothing that
`connect` and a re-pull do not. The mirror is re-pullable by construction
(ADR-0197). The intent store is not, and that is exactly why it does not belong
in a migration: it is the one file whose meaning a future build cannot verify
from the outside, so code that picks it up and carries it somewhere is code that
has to stay correct forever for an operation that runs once.

**A pre-record directory is left whole and untouched.** Not read, not moved, not
deleted, not counted, not reported. A person removes it by hand when they notice
it, the same treatment ADR-0197 gives a pre-grammar `mail.db`, and for the same
reason: code that touches a directory it cannot prove it wrote is the hazard the
boundary exists to prevent.

**Durable intent is still protected, inside the contract that owns it.** Once a
partition exists under this record's path, nothing removes its intent store
except the two operations that already exist for the purpose: `reconcile`
delivers it to Gmail (ADR-0199) and `discard --all` abandons it, both under the
account's reconcile lock, with `status` reporting what is owed. That guarantee is
about ordinary operation, and it neither implies nor requires that bytes written
before this record existed be carried into it.

The identity change gets the same treatment when it lands, for an additional
reason of its own: an email-named directory cannot be proven to belong to the
account that just authenticated. An address that moved between two Google
accounts, one renamed away and one taking the freed address, produces exactly one
directory that both can claim. No code can tell those cases apart, which is why
`sub` is being adopted at all, so the authenticated account starts an empty
partition and re-pulls.

### Partitions live under one directory the app names

An app's partitions sit under a single directory below the app directory, and
the app chooses what it is called:

```txt
<root>/
  epicenter.sqlite3                      the one Epicenter replica (ADR-0161)
  blobs/                                 the replica's byte spill (ADR-0172)
  app-catalog/
  apps/
    so.epicenter.local-mail/
      credentials.json                   0600, app root, never inside a partition
      accounts/
        <google-sub>/
          mail.v5.db                     disposable materialization (ADR-0197)
          intent.db                      durable app intent (ADR-0198)
          lock.db
    so.epicenter.local-books/
      credentials.json                   0600, and the connected-company index
      companies/
        <realmId>/
          books.v1.db
          lock.db
    <admitted-app-id>/                   named by its id, and not on disk
                                         until its app writes something here
```

The third entry is the whole of what widening the rule costs on disk: a name
that is spoken for. Every trusted app has one, an app that has written nothing
has an empty one that does not exist yet, and the two above are simply the apps
that have written something. An admitted app cannot write here today, which is a
fact about what it can reach rather than about what it owns.

Local Books is not made to say `accounts`. The rule is that there is one such
directory, not what it is called, because the word has to be true about the
thing being partitioned and only the app knows what that is.

The single partition directory earns itself once, on the hand-off rule alone:
the names above it are the app's and the names below it are an external
authority's, so app-root files and partition ids become structurally incapable
of colliding and no grammar has to forbid a company named `credentials.json`.

It is not justified by enumeration, and this record does not claim it is.
Neither app lists partitions by reading the directory; both ask their token
store (`listAccounts`, `listRealms`), which is also what replaced Local Books'
`companies.json`. A company that authenticated and never synced has no
directory and is still connected, so the disk was never the authority on that
question, and a level that exists only once its owner has written to it could
not have been.

### There is no acquisition protocol

An app does not ask for a partition. It creates one by writing into it, at the
moment it connects an authority and learns that authority's identifier for it.
Listing them is a read of the app's own token store and never of the disk, for
the reason given above: a partition that authenticated and never synced has no
directory and is still connected. Removing one is the owning app deleting
the directory. There is no allocation call, no registration, no host handshake,
no registry of partitions, and no storage manager. A partition exists exactly
when its directory does.

The app directory one level up follows the same rule, which is why giving one to
every app costs nothing to run. The host issues an id and stops. It does not
create the directory, count directories, notice an empty one, or remove one when
an app leaves the catalog: a directory whose app is gone is inert disk a person
deletes by hand, the same treatment a pre-record directory gets above. Reclaiming
it would mean deciding that bytes the host cannot read are no longer wanted.

### Disposability stays legible in the filename

Inside a partition, ADR-0197's grammar decides what is disposable:
`<name>.v<N>.db` is a materialization that a rebuild replaces, and reclamation
can reach nothing else. Everything outside that grammar, `intent.db` under
ADR-0198 and a lock file, is durable or runtime state that reclamation cannot
touch precisely because it does not match. This record adds no manifest, no
metadata file, and no marker distinguishing them. The filename is the whole
signal, and it already works.

Credentials stay at the app root, never inside a partition, which is ADR-0062's
rule carried to the new location for the reason it was written: a partition
directory is the thing handed to a read-only SQL surface or an agent.

## Consequences

- One directory now answers "what has Epicenter stored on this machine", and
  removing it removes everything. Today that question has one answer per app and
  no list of apps to enumerate.
- Both apps get the same upgrade treatment, and it is the cheapest one: connect
  again and re-sync. Neither carries migration code, neither names a pre-record
  path, and neither app's wave has a step that has to keep working after it runs.
  The symmetry is not tidiness; it is what having no released install buys, and
  it is spent once.
- Local Mail's cost is one reconnect per wave that changes a path, and there are
  two such waves. The re-pull each one costs is priced at 20 quota units per
  message (ADR-0196), which makes it slow rather than risky, and it is what a
  materialization is for (ADR-0193).
- **Deferring the identifier got more expensive, not less.** Every day the partition is
  named by an email is a day a Workspace rename can strand undelivered triage,
  and that failure is silent: the app finds no directory for the new address,
  creates one, and the old assertions are never delivered and never seen again.
  Before `intent.db` the same event cost a re-pull.
- **The two path changes are still separate waves, for a smaller reason than
  before.** Moving the app directory is mechanical and offline. Changing the
  segment that names an account needs a new OAuth scope, a live consent screen,
  and a rewrite of every surface that treats an address as an identity. They are
  not one PR because they are not one piece of work, not because one of them is
  dangerous.
- Nothing is deleted anywhere, and nothing is moved either. Both apps' pre-record
  directories are left whole, and no code in either names one. They are inert
  disk a person removes by hand, the same treatment ADR-0197 gives a pre-grammar
  `mail.db`, and for the same reason: code that touches a directory it cannot
  prove it wrote is the hazard the boundary exists to prevent.
- No pre-record path appears in code, so nothing has to be deleted later. This
  record leaves behind no transitional code, no one-release window, and no
  environment variable kept alive to be refused. Each app's README names its old
  directory once, in prose, so a person knows what the inert bytes on their disk
  are; that sentence is the whole of the transition and it costs nothing to keep
  correct.
- `companies.json` is deleted outright. The file existed to answer "which
  companies are connected", and `credentials.json` already answers it: the token
  store is keyed by `realmId`, so the index was a second copy that could disagree
  with the first. Local Mail has no such file and resolves its account from its
  token store, so this converges the two apps rather than inventing a shape. What
  goes with it is the recorded default, and a person with two companies passes
  `--realm` or sets `LOCAL_BOOKS_QB_REALM`. The replacement is `listRealms()`,
  not a directory read: a company that authenticated and never synced has no
  directory and is still connected, so the disk cannot answer the question.
- Amended 2026-09-08: Rust owns desktop path selection. Bun receives the selected
  paths, so startup no longer depends on two resolvers agreeing.
- Two current resolution bugs are fixed on the way past. A non-absolute
  `XDG_DATA_HOME` is now ignored rather than honoured, matching what the desktop
  host does, and Windows gets a real branch instead of landing in
  `%USERPROFILE%\.local\share`.
- **An app's stored shape stays private, so its owner keeps the right to change
  it.** No peer holds a path or a handle into it, so a corpus-version bump, a
  dropped column, or a rebuilt artifact breaks nobody. That freedom is the whole
  reason ADR-0197's version-named artifact works, and it survives only as long as
  the only readers are the owning app and the person at the keyboard.
- **Making a fact available to another app is deliberate work, and that is the
  point.** The owner publishes a verb, or a person promotes the fact into the
  shared replica. Neither happens by accident, so a directory read never becomes
  an undeclared dependency between two apps that ship on different schedules.
- **An app never has to change what it is in order to have somewhere to put its
  own state.** There is no promotion, no request, and no reviewable widening of a
  closed set. The cost of that is paid once, in a validated id rather than a
  typed union, and the reservation at admission is what keeps two apps from
  claiming one place.
- **Directories outlive their apps, on purpose.** Removing an app from the
  catalog leaves its directory whole, because the host cannot read what is inside
  it and will not decide those bytes are unwanted. A person deletes it, or
  deletes the one root and takes everything with it.
- What this forecloses: a host-owned registry of app stores, a storage or
  database capability namespace, per-app data roots, a `cacheDir` beside the data
  dir, a generic app-database framework, any host feature that reads inside an
  app's directory, a cross-app SQL surface or query router, a directory lookup by
  app id offered to app code, an allocation, uninstall, quota, or backup protocol
  over app data, and a per-app storage permission model.

## Considered alternatives

- **Leave each app computing its own OS root.** Rejected: ADR-0191 puts two of
  them in one process, and the arrangement has no answer for what the second root
  is doing there.
- **Keep Rust computing `EPICENTER_DATA_DIR` and add a TypeScript resolver for
  the CLIs.** Originally rejected to avoid duplicate resolution. Reconsidered
  2026-09-08: Rust now sends the resolved paths in the boot frame, without
  overwriting the environment. The desktop consumes one value; a standalone
  CLI's production default is a separate convenience.
- **Let one app read a peer's directory, read-only, since it is all local
  anyway.** Rejected: "all local" is an argument about the filesystem, and the
  cost is paid in the API. A peer that reads a mirror pins its stored shape, and
  the owner loses the version bump and the rebuild that ADR-0197 exists to give
  it. The owner would find out by breaking a caller, which is the coupling this
  record refuses, not the access.
- **Add a host query verb that takes an app id and runs SQL.** Rejected: it is
  the same coupling with a host in the middle, plus a new host surface that has
  to know every app's schema to be useful and to keep working. The owning app
  already has the two shapes worth having, a verb and a read model, and it can
  name what it means by them.
- **Give a directory only to a closed set of host-composed engines, and none to
  an admitted app.** Drafted into ADR-0202 and withdrawn before either record
  merged. It looked cheaper because an admitted app cannot reach a filesystem
  today, so the place would go unused; what it actually bought was a second class
  of app, a promotion ritual to move between them, and an identity change at
  exactly the moment an app has state to lose. The costs it claimed to avoid all
  survive the widening: the host still only names, so there is no verb, it
  still reclaims nothing so there is no uninstall lifecycle, a filesystem still
  provides no quota so none is promised, and the one genuine cost, an open id
  space reaching a `join`, is paid by validating the id against the grammar
  admission already enforces.
- **Give an admitted app a host-provided runtime, or any other host mechanism for
  reaching its own directory.** Rejected: it would adopt a resource nothing is
  contending for. A host that spawns per-app runtimes creates the port
  allocation, the supervision, and the shutdown ordering it would then cite as
  the reason it had to own them, which is a mechanism manufacturing its own
  justification. An app that needs a runtime ships as one, under the id it
  already has.
- **Give directory access a grant or permission model between apps.** Rejected:
  it would be a mechanism pretending to be a boundary. Every app here runs as the
  person who owns the machine and can already open any file that person can, so
  the grant would enforce nothing an app could not route around, while adding a
  policy surface to configure and a false sense that the enforcement is real. The
  rule and code review are the enforcement, and saying so is more honest than
  shipping a lock with no door.
- **Add `epicenter.storage.open(...)` to the capability handle.** Rejected:
  ADR-0181 refuses the namespace as an implementation category and ADR-0193
  refuses it as ownership Epicenter does not have. Neither refusal has weakened,
  and no caller has appeared.
- **Give the app a `dataDir` and a `cacheDir`.** Rejected: it splits one
  ownership boundary in two and puts the disposability signal in the path, where
  it can disagree with the filename that already carries it.
- **Keep the account email as Local Mail's partition name.** Rejected on the
  provider's own documentation, which says the value can change and instructs
  callers not to key on it. The failure is a silently duplicated mailbox, and the
  fix costs one scope.
- **Mint a local partition id and keep a map to the account.** Rejected: the map
  is a durable file whose loss orphans the partition, and finding the entry needs
  the same account inputs anyway. ADR-0151 rejected this shape for account
  directories on the same reasoning.
- **Make both apps use `accounts/` for symmetry.** Rejected: a QuickBooks company
  is not an account, and imposing one app's vocabulary on another buys nothing
  the single-directory rule does not already buy.
- **Flat partitions directly under the app directory, as both apps did before
  this record.** Rejected: it merges a namespace the app names with one an
  external authority names, and the app cannot defend the collision because it
  does not issue the identifier. What replaces the level is a reserved-name rule
  against a provider that never agreed to it.
- **Drop `apps/` and put each app directly under the root.** Rejected on the
  same rule one altitude up. The host's root namespace grows by host decisions
  and the app namespace grows by app decisions, so merging them makes every
  future host directory a collision risk against an app id. It also deletes the
  only positional form of the host's promise: with `apps/`, "Epicenter does not
  look inside" is a place; without it, it is a list of names that has to stay
  correct as both sides grow.
- **Move the existing directories on first run.** Built, then deleted, which is
  the strongest form of the rejection. It reads a pre-record path, needs a rule
  for a directory that is already at the destination, a rule for a lost race
  between two surfaces, a rule for a cross-filesystem rename, and a refusal for
  the collision it cannot resolve, and every one of those has to stay correct
  until the code is removed. All of it is bought for local development state on
  a product with no released install. `connect` and a re-pull cost a person less
  than the paragraph explaining the alternative.
- **Carry `intent.db` across either path change, by copy or by gate.** Rejected:
  it is a migration for the one artifact the app defines as existing in order to
  stop existing, written, tested, and kept correct forever for an operation that
  runs once per account. Gating the change on an empty store is the same
  purchase in a cheaper wrapper: it still teaches the identity path to reason
  about the contents of a directory written under a contract that no longer
  holds.
- **Strand a partition silently while an account is in service.** Rejected, and
  distinct from the clean break above. Leaving a pre-record directory alone costs
  a person a reconnect they were told about; losing a live partition to a
  Workspace rename costs them triage they recorded and were never told about.
  That second failure is the whole reason to adopt `sub`.
- **Put the app directory under the OS cache root so backup exclusion is free.**
  Rejected: a partition holds a durable intent store beside a disposable mirror,
  and cache-class storage on macOS is evictable under disk pressure. Free backup
  exclusion is not worth an OS-initiated deletion of undelivered triage. A
  restored partition is separately safe under this record, because the mirror
  syncs forward from its own cursor and a restored assertion is idempotent when
  re-delivered: asserting a label Gmail already has is the same request twice.
- **Extract a shared mirror or materialization package now.** Rejected on
  evidence, not on principle. Two prototypes of an ownership API for exactly this
  (`prototypes/materialization-api` and `examples/mirror-api`, both on open
  branches) reached the same conclusion: the lifecycle contract is expressible,
  and the two samples still disagree wherever the abstraction is hardest, so the
  package waits for a third provider. What this record takes from them is the one
  piece that does not: paths belong to a layer above the app, which is small,
  mechanical, and needs no package.
