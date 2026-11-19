# 0202. A provider account belongs to the app whose durable state it names, and Epicenter brokers none

- **Status:** Accepted
- **Date:** 2026-08-03
- **Amends:** [ADR-0074](0074-the-secret-vault-is-an-owner-scoped-synced-store-encrypted-under-a-server-derived-keyring.md) at one clause, what the vault may hold: accounts and third-party grants leave its scope, and it keeps the brought values that name no durable local state. Its key source, its refusal of a passphrase and a `locked` state, and its `available | missing` read contract are unchanged and restated as still governing.
- **Completes:** [ADR-0201](0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md) at the one question it left open, who owns the provider grant that names a partition. It amends nothing there.
- **Corrected 2026-08-03, before merge.** A draft of this record carried a second amendment to ADR-0201, narrowing "an app receives one directory" to a closed set of host-composed engines and giving an admitted app none. That is withdrawn: every trusted app has one place, ADR-0201 says so at full width, and the section below is rewritten to decide only what this record is actually about. Every refusal here survives the correction unchanged, because none of them was resting on the narrowing.
- **Relates:** [ADR-0188](0188-gmail-app-identity-belongs-to-the-distribution-and-no-epicenter-server-enters-the-gmail-path.md) (clause 5 decided this for Gmail; this record lifts it to the general rule without changing anything Gmail-specific), ADR-0179 (admission is the protection, and there are no per-app permissions), [ADR-0181](0181-every-app-receives-one-portable-epicenter-capability-handle.md) (the closed capability namespace, which this record does not widen), [ADR-0183](0183-epicenter-mediates-the-effects-it-owns-and-names-the-rest-unmediated.md) and [ADR-0185](0185-trusted-app-http-uses-tauris-standard-transport-without-observation.md) (what the host mediates and what it declines to observe), ADR-0186 (how an admitted surface reaches Epicenter), [ADR-0109](0109-hosted-tauri-auth-keeps-app-owned-keyring-edges-until-three-real-callers-earn-sharing.md) (the third-caller trigger this record borrows for OAuth plumbing), ADR-0062 (the on-disk token lineage), [ADR-0081](0081-per-upstream-oauth-concurrency-decides-mirror-topology.md) (per-upstream concurrency, which is what a shared holder would violate), [ADR-0054](0054-an-inference-backend-is-the-metered-gateway-or-a-custom-server.md) (a device-scoped endpoint's key stays device-local), [ADR-0161](0161-each-person-has-one-epicenter-replicated-on-each-adapter-boundary.md) (the one replica a person promotes facts into), [ADR-0196](0196-local-mails-mirror-is-a-reader-and-one-full-message-fetch-is-its-entire-budget.md), [ADR-0197](0197-a-mirrors-corpus-version-names-its-artifact-and-only-the-app-knows-when-one-is-ready.md), [ADR-0198](0198-a-durable-local-mail-write-is-a-per-message-label-assertion-in-a-sibling-intent-database.md), and [ADR-0199](0199-one-account-reconciler-is-local-mails-only-gmail-writer.md) (all untouched, and deliberately: they govern ordinary operation inside a partition, and this record decides only who owns the partition and the grant that names it)
<!-- doc-path-check: ignore-next-line (the vault wiring spec is deleted by this decision; git keeps the body recoverable) -->
- **Deletes:** `specs/20260701T150000-api-keyring-and-vault-wiring.md`, which was ADR-0074's executable plan. It is unexecutable as written: it wires `packages/encryption` and `packages/workspace`, both since deleted from the tree, and half of what it moves into the vault leaves the vault's scope here. Git keeps the body recoverable and `docs/spec-history.md` keeps the row.

## Context

Two questions have been answered per app and never in general: who holds a
third-party provider grant, and which apps own durable bytes on the machine.

ADR-0201 settled where an app's bytes live and refused to make that directory an
inter-app API. It did not decide who owns the credential that names the
directory. ADR-0188 decided it for Gmail, in a clause that reads as a compliance
argument about one provider: no Epicenter server participates in the Gmail path,
because restricted data reachable through a third-party server triggers an annual
security assessment. ADR-0062 decided the file mode for QuickBooks tokens. Three
records, one unstated rule, and nothing to consult when a third provider arrives.

The absence has a cost with a direction. Google's browser-level authentication
makes an individual app's OAuth grant cheap to obtain, and a cheap grant makes a
shared "connected accounts" surface look like an obvious convenience rather than
a new subsystem. The tempting shapes are all one step away from what already
ships: a registry of connected providers, a shared refresh-token store, a
"disconnect Google everywhere" lifecycle, and a cross-app operational store to
hold them. Each looks like a feature until it has to say what happens to
`intent.db`, whose contents ADR-0198 defines as the only irreplaceable local
state Local Mail has.

ADR-0074 is the one live record pointing the other way. It designates a
user-global synced store as the home for "the things you bring: your accounts,
your API keys, your credentials", encrypted under a server-derived keyring and
shared by every first-party app. Its evidence was real for one of those three
nouns: two apps wanted the same Groq key. It was never argued for the other two,
and ADR-0188 has since closed the Gmail case against it explicitly. The vault's
own primitives have since been deleted with the encryption layer, so the record
now describes a subsystem that has no code and a scope the corpus contradicts in
one place.

The second unstated rule is which apps hold a grant at all. Every trusted app has
a place under ADR-0201, and only some of them ever authenticate to a third party;
nothing said which, or on what basis, so the answer would have been read off
whichever app happened to do it first.

## Decision

**A third-party provider account belongs to the app whose durable local state it
names. Epicenter authenticates a person, owns the shared curated replica, and
admits and composes trusted apps; it never brokers, stores, refreshes, revokes,
or enumerates a third-party grant.**

### The discriminator is what the credential names

The rule that decides future providers without a registry is not "apps are
trusted". It is this: **a credential that names durable local state belongs to
whoever owns that state; a credential that names nothing is a value, and values
already have a home.**

Gmail's grant names `accounts/<google-sub>/`, which holds a mirror, a lock, and
an intent store. QuickBooks' grant names `companies/<realmId>/`. A Groq API key
names nothing: no directory, no partition, no lifecycle. The first two are
inseparable from the bytes they address, and moving them somewhere the owning app
does not control means some other party can invalidate state it cannot read. The
third is a value a person carries, and its home is the question ADR-0074 answers.

### Every app has a place; not every app holds a grant

The discriminator above is about credentials, and it is enough on its own. A
draft of this record reached for a second one, a split between host-composed
engines and admitted surfaces, and used it to decide both questions at once: only
an engine gets a directory, therefore only an engine holds a grant. The first
half was wrong as a product decision and is withdrawn. The second half never
needed it.

**Under ADR-0201 every trusted app has one private directory, allocated by its
id when the host admits it.** So an app that connects a provider holds that
provider's grant, in a `0600` file at its own app root, beside the state the
grant names. Whether the app arrived as a composed engine or as an inert admitted
folder decides nothing about ownership; it decides only what that app can reach
today, which is a capability question and belongs to ADR-0181 and ADR-0186.

An app that authenticates nothing holds nothing, and that is most apps. The rule
is not a split between kinds of app but a consequence of what a credential names:
no durable state, no grant to own, and no place the grant would have to sit
beside. A brought API key that names nothing at all keeps its own home, below.

What stays true either way is that Epicenter holds none of it. The `epicenter`
handle has three namespaces today (`data`, `recording`, `transcription`), no
filesystem and no accounts anywhere in it, and this record adds neither: ADR-0181
refuses `storage` as an implementation category and ADR-0201 refuses it as
ownership Epicenter does not have. An app with a directory and no way to reach it
is waiting on a capability decision nobody has made, not on a promotion.

**One app-id namespace, and the reserved set is how it stays one.** Catalog
admission reserved the built-in surface ids (`home`, `whispering`, `honeycrisp`,
`mail`, `books`) and nothing else, so a folder named `local-mail` was
admissible. Under the narrowing that was withdrawn this was a latent defect,
harmless because an admitted app owned no place; once every app owns the
directory its id names, admitting that folder issues a second claim on the
directory Local Mail's `intent.db` sits in. No admitted app can act on that claim
today, because none can reach a filesystem, so what closes is the ownership
collision rather than an exploit. The ids the composition root has already spent
join the reserved set, from one expression both admission call sites read: an app
id that names a place is not available to a folder that would only borrow the
name.

### What Epicenter does not keep

Four things, refused together because they are one shape wearing four hats:

- **No global connected-provider registry.** Nothing enumerates what a person is
  connected to across apps, because enumerating it requires a durable map from a
  registry-minted connection id to the provider's own identifier, which is the
  shape ADR-0151 and ADR-0201 already rejected: a locally minted identifier turns
  a recoverable credential loss into a data loss.
- **No shared refresh-token vault.** A refresh token that names a partition stays
  in the owning app's `0600` file beside that partition's directory (ADR-0062,
  ADR-0201). ADR-0188 clause 5 states this for Gmail with a compliance argument;
  the general reason is ownership, and it holds for providers with no restricted
  scopes at all.
- **No shared account lifecycle.** There is no host-level connect, disconnect,
  refresh, or revoke. A cross-app disconnect would require the host to decide
  what happens to an app's undelivered intent, which means reasoning about the
  contents of a directory it does not own, and ADR-0201 forecloses that even for
  the app's own migration.
- **No cross-app operational store.** ADR-0201 settled this and nothing here
  reopens it: no peer path, no peer handle, no host verb taking an app id, no
  cross-app SQL.

Each refusal is a refusal of a mechanism, not of a capability a person has today.
Nothing a person can currently do stops working.

### Share the mechanism, never the account

The honest cost is real duplication. Local Mail and Local Books each carry a
loopback OAuth flow, a token set, a `0600` file store, and a resolve-the-active
partition helper, over the same library, in roughly 700 near-parallel lines
apiece. That is duplication of a mechanism, and ADR-0109 already priced this
class: keep the app edge at two callers, extract at three real ones.

When a third composed engine with a loopback provider lands, extract a **library**
the app calls, never a **service** the app registers with. The app keeps the
client id, the scopes, the partition name, and the file path. A library has no
lifecycle, no registry, no grant model, and no cross-app disconnect semantics,
which is the entire difference between sharing code and sharing an account.

### Cross-app use keeps the two forms it already has

Unchanged from ADR-0201 and restated only so this record stands alone: the owning
app publishes a verb in its own vocabulary, or a person promotes a durable fact
into the one replica (ADR-0161). The second form is stronger than a runtime
registry and needs no host: two apps share data by importing the same Lens
contract module, with neither the apps nor the contract depending on the client.
A verb returns data, never a location.

### What the vault may still hold

ADR-0074's vault keeps the brought values that name no durable local state:
provider API keys and the like. Accounts and third-party OAuth grants leave its
scope, and that clause of it is withdrawn rather than reinterpreted. Everything
else about it stands: the key source is server-derived and never a passphrase,
there is no `locked` state, a secret has one home, and every consumer reads
`available | missing`.

The vault's synced half remains unbuilt and is now further from the tree than
when it was accepted: `@epicenter/encryption` and `packages/workspace` are both
deleted, so a synced secrets path is a rebuild rather than a wiring job.
Whispering's device-local plaintext facade is the shipped and correct degenerate
in the meantime. Whether a brought key is person-owned or app-held is a product
question this record does not settle, and it is the one open question whose
answer moves a whole subsystem: if the answer is app-held, ADR-0074's device-local
predecessor rule in ADR-0054 is simply correct and the vault retires outright.

### This is an ownership boundary, not a sandbox

Restated from ADR-0179 and ADR-0201 because it is the clause most likely to be
misread as a security claim. Installed apps are trusted admitted code that runs
as the person who owns the machine. The rules above are API and ownership rules
between first-party code, enforced by one owner per directory and by code review.
There is no grant, no permission prompt, no capability token for a directory, and
no per-app storage policy, because every one of those would advertise an
isolation boundary that does not exist. ADR-0185 already settled the matching
question for network egress: the host declines to observe ordinary app HTTP
rather than pretending to mediate it.

## Consequences

- A third provider app has a rule to follow instead of a precedent to guess at.
  Hold your own grant, name your own partition, keep your token file at your app
  root, and publish a verb if anyone else needs a fact.
- **The one real loss is a single "what am I connected to" view, and there is no
  intention to fake it.** The cheap escape hatch, if a person asks for it, is a
  read-only Home view that calls each composed engine's existing status verb.
  That is a view over verbs, with no registry, no grant model, and no host
  knowledge of any provider. Build it when somebody asks, not before.
- Connecting the same provider in two apps costs two consent screens. Under
  ADR-0081's concurrency ceiling that is free for Google, and ADR-0188 already
  accepted the same cost per device for the same reason.
- ADR-0074 shrinks to the case it actually had evidence for, and its executable
  spec is deleted rather than left in the tree describing packages that no longer
  exist. A future synced-secrets path is designed against the current data plane.
- An app that wants a provider does not need permission, a registry entry, or a
  change of class. It needs a client id, a token file at its own app root, and a
  partition named by the authority. That is the same list for every app.
- The `local-mail` catalog-id collision is closed as part of the decision that
  makes it real, rather than by a later widening that would have to remember it.
- **What this forecloses:** a host-owned provider or integrations API, an
  `epicenter.accounts` namespace, incremental per-app scope grants, a shared
  refresh coordinator, revocation fan-out, a connection-id-to-provider-identifier
  map, a host-owned uninstall or backup protocol over app data, and any settings
  surface that must know every provider to render.

## Considered alternatives

- **Epicenter owns the provider connection and lends it to apps.** Rejected, and
  it fails independently at five layers, any one of which is fatal. One Google
  client serving many apps puts the union of every app's scopes on one consent
  screen, so adding a Calendar app silently widens Mail's grant, and the only fix
  is per-app incremental consent, which is the per-app permission model ADR-0179
  refused. A shared store that syncs puts Gmail refresh tokens on a server and
  re-triggers ADR-0188's annual assessment. ADR-0081's per-realm concurrency
  ceiling forbids lending one QuickBooks grant to two apps. A cross-app disconnect
  makes the host reason about an app's undelivered intent. And the registry needs
  the minted-identifier map ADR-0151 rejected. The prize for accepting all five
  would be one credentials file instead of two.
- **Retire ADR-0074 outright and make every brought key app-held.** Rejected for
  now, though it stays live. Its cross-app observation is real, its read contract
  is shipped and useful, and the question it turns on is a product question about
  whether a person owns their provider key. Withdrawing the accounts clause is
  the part the evidence forces; withdrawing the rest is a bet this record has no
  cause to place.
- **Give a directory only to host-composed engines.** Drafted here, then
  withdrawn as a product decision; ADR-0201 records why and what the widening
  does and does not cost. It is listed here because this record is where the
  narrowing was written, and a reader who remembers it should find it refused
  rather than absent.
- **Keep the rule per app, as it is today.** Rejected: it is three records for one
  rule, none of which a third provider app can consult, and the shape it leaves
  undecided is the one that gets built by accident.
- **A generic `epicenter.accounts` or integrations API.** Rejected: it is the
  registry above with a nicer name, and it requires a provider catalog, a scope
  model, and a settings surface that has to know every provider to render.
- **A per-app grant or permission model over directories and providers.**
  Rejected for the third time, and the reason has not weakened: every app runs as
  the person who owns the machine and can already open any file that person can,
  so the grant would enforce nothing while advertising that it does.
