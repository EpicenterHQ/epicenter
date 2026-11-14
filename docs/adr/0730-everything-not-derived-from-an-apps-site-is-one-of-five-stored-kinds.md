# 0730. Everything not derived from an app's site is one of five stored kinds

- **Status:** Superseded
- **Date:** 2026-11-04
- **Superseded by:** [ADR-0899](0899-the-folder-sync-product-is-retired.md): the folder sync product is retired, and this record is its history.
- **Amends:** [ADR-0719](0719-every-change-to-the-data-model-is-checked-against-eight-principles.md) at principle 5, "Find things by convention; store only the exceptions": it becomes "Derive from the site; store only data, decisions, proofs, exceptions, and caches."
- **Relates:** [ADR-0721](0721-an-apps-folder-is-derived-never-stored.md) (the folder is derived), [ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md) (names from the host), [ADR-0723](0723-an-apps-site-is-found-by-convention.md) (the site by convention), [ADR-0731](0731-every-app-signs-in-as-its-site.md) (sign-in by site).

## Context

Principle 5 of ADR-0719 says a program finds things by convention and stores
only the exceptions. It was written for folders: a folder's path derives from
the site and environment, and a folder kept elsewhere is a link.

The same move kept deciding other questions. The folder list in the global Git
configuration (`epicenter.folder`) was removed because a scan finds the
folders. A contract's `name` was removed because the site names the app. The
sign-in session in `~/.epicenter`, its lock, a device id, and each app's
hand-written `clientId` and scope strings were removed because the site and
the server's grant answer them (ADR-0731). Each time, what survived as stored
state was not only an exception: a grant is a decision, a refresh token is a
proof of one, and a SQLite index is a cache. Principle 5 named one kind and
left the rest unexplained.

## Decision

**Everything about an app derives from its site, its environment, and the
person; what is stored is one of five kinds.**

| Kind | Example | Who makes it |
| --- | --- | --- |
| Data | notes, settings notes | the person, the app, agents |
| A decision | a grant ("Allow"), `epicenter.synced` | the person, once |
| A proof of a decision | a refresh token | the platform, never app code |
| An exception to a convention | a link at a folder's derived path | the person |
| A cache that can be rebuilt | a SQLite index, the generated block in `AGENTS.md` | anyone; deleting it loses nothing |

A design that stores anything else names the kind it is. If it is none of the
five, it is derived instead.

Principle 5 of ADR-0719 reads: **Derive from the site; store only data,
decisions, proofs, exceptions, and caches.**

## Consequences

- A review asks of each stored value which kind it is. A value that is none of
  the five is a synchronization obligation without an owner, and is removed.
- Decisions live where the decider's authority lives: a grant on the server, a
  folder's sync consent in that folder's own Git configuration.
- Proofs are held by the platform (the shell or the browser client), so an
  app's code never chooses where they are kept.

## Considered alternatives

- **Keep principle 5 as written.** It explains folders and links, and leaves a
  grant, a token, and an index looking like violations.
- **A separate principle for credentials.** Splits one rule into two and
  repeats "store only what cannot be derived".
