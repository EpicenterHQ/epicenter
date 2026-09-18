# 0246. An app is named by its full reverse-domain id everywhere, including the ones Epicenter ships

- **Status:** Accepted
- **Date:** 2026-08-18
- **Amended by:** And by [ADR-0402](0402-a-window-label-is-identity-never-authority-and-the-capability-is-a-host-constant.md) at the consequence asking for a test of the granted set per label: the capability names `"windows": ["*"]` and selects no label, so the migration touches no capability file.
- **Not yet executed.** The decision is made; the code still ships bare built-in ids. The migration this needs (on-disk `apps/<app-id>` directories, capability window labels, the deep-link and route strings) is a wave of its own, and the orphaned directories named in Consequences are the open question inside it.
- **Amends:** [ADR-0210](0210-an-installed-app-declares-its-name-and-the-namespace-it-owns.md), withdrawing the bare-label grammar for built-in ids. ADR-0210 is already superseded by [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md), but its grammar still governs live code (`parse_application_id` in `apps/epicenter/src-tauri/src/lib.rs`, the reserved-id reasoning in `deriveAppCatalog`), so it needs an explicit withdrawal rather than inheritance from a superseded record.
- **Relates:** [ADR-0243](0243-a-workspaces-id-is-its-applications-reverse-domain-identifier.md) (a database's id is its app's reverse-domain identifier), [ADR-0201](0201-epicenter-owns-one-app-data-root-and-an-app-partitions-its-one-directory-by-a-stable-authority-identifier.md) (an app owns `apps/<app-id>` under the one data root), [ADR-0244](0244-epicenter-speaks-of-apps-and-windows-not-surfaces.md) (app, window, route).

## Context

Epicenter has two ids for the same app today. ADR-0243 says a database's id is
its application's reverse-domain identifier, and Honeycrisp's is
`so.epicenter.honeycrisp`. The host calls that same app `honeycrisp`.

That split was deliberate. ADR-0210 kept built-in ids as bare labels precisely
so they could not collide with admitted ids, which always contain a dot: the two
sets are disjoint by grammar, so no reserved-id list is needed and none can be
forgotten. The rule works. It is also a special case, and the product moved out
from under it: Epicenter's own apps are meant to be apps a person installs, some
of them preinstalled, with no privileged tier. An app that ships in the release
should not be a different kind of thing from one that does not.

A shorter alternative was considered on the way here: keep dotted ids as the
identity but address apps by the last segment, so `/apps/honeycrisp/` survives.

## Decision

**One app, one id, spelled the same everywhere.** Every app is named by its full
reverse-domain identifier, including the ones Epicenter compiles into the
release. `honeycrisp` becomes `so.epicenter.honeycrisp`; `home`, `whispering`,
`mail`, and `books` become `so.epicenter.*` alike.

That id is the whole identifier, with no short form anywhere:

- the route, `/apps/so.epicenter.honeycrisp/`
- the deep link, `epicenter://app/so.epicenter.honeycrisp` (ADR-0244)
<!-- doc-path-check: ignore-next-line -->
- the directory under the one data root, `apps/so.epicenter.honeycrisp` (ADR-0201)
- the database id it declares (ADR-0243), which is now the same string
- the Tauri window label, through the existing `.`-to-`_` mangling, which every
  window now goes through rather than only admitted ones

Collision safety moves from grammar to prefix. `so.epicenter.*` is Epicenter's,
the way `com.apple.*` is Apple's, and anyone who owns a domain owns their own
prefix. A reserved-id list is still refused; it is now unnecessary for a
different reason than before.

## Consequences

- The two-ids-for-one-app incoherence is gone, and ADR-0243 reads literally
  rather than aspirationally.
- Epicenter's own apps stop being a special case in the launch path. The host
  resolves every id the same way, and `parse_application_id` loses the arm that
  distinguished bare labels from dotted ones.
- Every window label goes through one function. The mangling already exists for
  admitted apps, so this deletes a branch rather than adding one.
- The loopback route gets longer. It is `http://127.0.0.1:39130/apps/...` on a
  machine-local origin that nobody types, shares, or bookmarks, so the cost is
  paid entirely by people reading logs.
- **The on-disk migration is the real cost.** `apps/<app-id>` is named by the
  id (ADR-0201), so existing directories orphan. Whoever executes this owns
  deciding between a rename pass, an accepted loss, or a compatibility read;
  this record does not decide it, because the answer depends on whether any
  installed build has written data under the bare names.
- Capability files in `src-tauri/capabilities/` change the window labels they
  select. A mistake there silently grants nothing rather than failing loudly,
  so it wants a test that asserts the granted set per label.

## Considered alternatives

- **Address by the last segment (`/apps/honeycrisp/`).** Rejected. The id would
  stop being the address, so a mapping has to exist somewhere, and it can
  collide: `so.epicenter.honeycrisp` and `com.acme.honeycrisp` both end in
  `honeycrisp`, which reintroduces exactly the reserved-list problem ADR-0210
  deleted. Paying a mapping and a tiebreak rule to shorten a loopback URL nobody
  reads is the wrong trade.
- **Keep bare labels for built-ins.** Rejected: it is the current state, it
  contradicts ADR-0243, and it encodes a privileged tier the product no longer
  has.
- **Keep bare labels but make the database id match them.** Rejected: it would
  reverse ADR-0243 instead, giving up the reverse-domain namespace that makes an
  id globally meaningful and makes two apps able to meet at one database.
