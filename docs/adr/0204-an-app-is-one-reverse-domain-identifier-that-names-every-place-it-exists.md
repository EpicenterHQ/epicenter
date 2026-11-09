# 0204. An app is one reverse-domain identifier, and that identifier names every place the app exists

- **Status:** Accepted
- **Date:** 2026-08-03
- **Amended by:** [ADR-0243](0243-a-workspaces-id-is-its-applications-reverse-domain-identifier.md)
  at the public name: a workspace exposes this value as `id`, not `namespace`.
- **Amends:** [ADR-0201](0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md) at one clause, the grammar of an app id, which becomes the reverse-domain namespace grammar ADR-0178 already defines. Everything else there stands: the host still names rather than allocates, the directory is still a place and never an inter-app API, and reach is still refused. Also [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md) at one clause, what a candidate folder is named, which is now the app's declared identifier rather than a bare folder name.
- **Amended by:** [ADR-0589](0589-an-app-is-one-git-repository-of-built-files-at-an-address.md) at the reverse-domain id as the name of every place an app exists: an installed app is named by its address, and a first-party app's OAuth client id stays a constant in its code.
- **Relates:** [ADR-0178](0178-row-facts-and-value-facts-are-separate-relations-keyed-by-structured-coordinates.md) (the reverse-domain namespace grammar this adopts), [ADR-0160](0160-lenses-interpret-durable-namespaces-without-creating-lifecycle-scopes.md), [ADR-0181](0181-every-app-receives-one-portable-epicenter-capability-handle.md), [ADR-0186](0186-an-app-reaches-epicenter-through-one-bundled-mit-client-it-installs-itself.md), [ADR-0203](0203-epicenter-owns-only-what-is-already-contended.md) (the id is the one contended resource, which is why this record is about a name and nothing else)

## Context

An app has two names today, and nobody decided that.

The replica already names an app correctly. ADR-0178 defines a durable namespace
as a reverse-domain string, "two or more lowercase, dot-separated labels", and
the shipped Lenses use it: `so.epicenter.home`, `so.epicenter.honeycrisp`,
`so.epicenter.chat`, `so.epicenter.settings`.

Everything outside the replica uses a different name from a different space.
ADR-0201's app directory, ADR-0179's admitted folder, and the served route at
`/apps/<id>/` all use a flat `[a-z0-9-]+`: `home`, `honeycrisp`, `local-mail`.

So Honeycrisp is `so.epicenter.honeycrisp` in one half of the system and
`honeycrisp` in the other. Both names are correct, neither is wrong, and holding
both is a lookup table every person and every agent has to carry.

The flat space has a second problem the replica does not. Its only arbiter is
Epicenter's own admission check, so two publishers who have never coordinated
both want `notes`, and the one who arrives second is refused for a reason that
has nothing to do with them. ADR-0179 designed for exactly that population:
"a folder may come from a publisher URL, a self-hosted builder, a local
developer build, or offline media."

## Decision

**An app declares one reverse-domain identifier. That identifier is its Lens
namespace, its directory name, its served route segment, and its origin-storage
prefix. There is no second name.** A display title stays separate and may change
freely, because it names nothing.

```txt
so.epicenter.local-mail
  Lens namespace       rows and values in epicenter.sqlite3
  directory            <root>/apps/so.epicenter.local-mail/
  route                /apps/so.epicenter.local-mail/
  origin storage       the key prefix its browser storage uses
```

The grammar is ADR-0178's namespace grammar, unchanged and shared, because these
were always one namespace being spelled two ways.

**Epicenter does not mint it.** The app declares it, and admission refuses a
collision with an identifier already spoken for. That is the same mechanism as
before, applied to a space where accidental collisions between uncoordinated
publishers stop happening.

### Why reverse-domain, stated honestly

ADR-0201's rule is that a name comes from whoever has authority over it, and it
applies that rule one level down by naming a partition with an identifier the
external authority issues. This record applies the same rule one level up: an
app's publisher, not Epicenter, has authority over the app's name.

**It is convention, not enforcement, and that is the whole claim.** ADR-0179
refuses provenance verification outright, so nothing checks that `com.acme.notes`
was published by acme.com. This works the way Java package names work rather than
the way Apple bundle identifiers work. What it buys is that two publishers who
never spoke stop colliding by accident; it buys nothing against a publisher who
squats deliberately, and admission's collision check is still what catches that.

### The full identifier goes on disk

`<root>/apps/so.epicenter.local-mail/` repeats `so.epicenter`, because the root
is named by the host's bundle identity and the app is named by its publisher, and
for a first-party app those are the same organization. The repetition is a
coincidence of authorship, not a structure: a third-party app is
`<root>/apps/com.acme.notes/` and nothing repeats.

Taking only the last label would make the disk name a lossy derivation of the
identity, so `com.acme.notes` and `so.epicenter.notes` would both land on `notes`
and the collision the identifier exists to prevent would return in the one place
it does damage. macOS settled the same question the same way.

## Consequences

- **An app's whole footprint is one string.** Searching for
  `so.epicenter.local-mail` finds its Lens, its directory, its route, and its
  storage prefix. "What does this app keep on my machine" becomes a question a
  person can answer without a map, which is what having two names cost.
- Nothing is minted, so nothing has to be looked up. Two devices, two processes,
  and two agents derive the same name from the same declaration.
- `COMPOSED_APP_IDS` and the reserved set keep their job unchanged; they just
  hold reverse-domain strings.
- The id is still deliberately not a surface id (ADR-0201). Home's launcher may
  rename a window; nothing about that touches where data lives.
- Existing ids change, which is a path change for every app that has one. Neither
  Local Mail nor Local Books has a released install, so this is the same clean
  break ADR-0201 already priced: reconnect and re-sync, no migration code.
- **What this forecloses:** a second app-facing name of any kind, a display name
  that addresses anything, a registry mapping one name to another, and any host
  API that takes a short id and resolves it to a long one.

## Considered alternatives

- **Keep both names.** Rejected: it is the status quo, and the cost is a lookup
  table carried by everyone forever for no benefit anybody named.
- **Make the replica adopt the flat name instead.** Rejected: it moves the wrong
  one. The flat space has no external authority and cannot stop two publishers
  from colliding, and ADR-0178's grammar is already shipped and already right.
- **Keep the leaf only on disk**, so `apps/local-mail/`. Rejected above: it makes
  the path a lossy derivation of the identity and reintroduces the collision.
- **Split publisher and app into two path segments**, `apps/so.epicenter/local-mail/`.
  Rejected on ADR-0201's own test: a level exists where naming authority changes
  hands, and the same publisher chooses both halves. One authority, one segment.
- **Verify the domain at admission.** Rejected: ADR-0179 refuses provenance as a
  trust input, and a verifier would be a registry, a network dependency, and a
  trust level this system deliberately does not have.
