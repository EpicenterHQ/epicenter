# 0732. A grant reaches what the person chooses at consent

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amends:** [ADR-0731](0731-every-app-signs-in-as-its-site.md) at "What an app can reach derives from its origin": an app's grant names the repository the person chose at consent, by [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md); at "one client, `so.epicenter`": Epicenter's client is its origin, `https://epicenter.so`, which also accepts device authorization in place of `so.epicenter.cli`; [ADR-0718](0718-epicenters-machinery-on-a-machine-lives-in-a-hidden-home-every-program-reads.md) at "Secrets stay in the keychain" and "Epicenter's AppData keeps only Epicenter's own window state": the engine's refresh token is a file in Epicenter's AppData.
- **Relates:** [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) (a repository grant names an account, an origin, and a repository), [ADR-0633](0633-apps-open-local-data-before-connecting-services.md) (consent never selects data by name alone), [ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md) (names from the host), [ADR-0740](0740-every-credential-an-app-holds-lives-in-its-own-place.md) (where each credential lives).
- **Amended by:** [ADR-0770](0770-teams-own-repositories-and-sharing-is-membership.md) at what consent offers: a team, whose repository for the app the grant names.
- **Unbuilt:** the `https://epicenter.so` client with the loopback authorization code and device authorization; consent preselecting the repository named from the host; moving the first-party web clients in `BROWSER_APPS` (`so.epicenter.todos`, `so.epicenter.honeycrisp`, `so.epicenter.capture`, and the rows keyed by `APPS.*.id`, all `skipConsent: true` in `apps/api/worker/oauth-registrations.ts`) to origin clients that show consent; moving the CLI's refresh tokens from the keychain service `so.epicenter.auth` (`AUTH_KEYCHAIN_SERVICE` in `packages/cli/src/secrets.ts`, used by `packages/cli/src/auth.ts`) to the file in Epicenter's AppData.

## Context

[ADR-0731](0731-every-app-signs-in-as-its-site.md) made every app's client
its origin. It also said what a grant reaches derives from that origin: the
app's own repository and documents, named from its host
([ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md)), and inference.

[ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) had already
decided reach differently. A repository grant names an account, an origin,
and one repository by id. At consent, the repository with the suggested name
is preselected and the person may choose another. Two cases need that choice:
a repository someone shared with the person
([ADR-0612](0612-a-repository-is-shared-by-the-people-on-its-access-list.md)),
and a second repository for the same app, such as a work Whispering beside a
personal one. A reach derived from the host names exactly one repository,
`<account>/whispering`, and reaches neither.
[ADR-0633](0633-apps-open-local-data-before-connecting-services.md) adds that
consent connects data and never selects it by name alone.

ADR-0731 also kept `so.epicenter` as the client of the Epicenter app and its
engine, and retired `so.epicenter.cli`. Both ids are reverse-domain strings
(`apps/api/worker/oauth-registrations.ts`), so Epicenter would be the one app
whose client is not its origin. Terminals and agents sign in today with the
device grant on `so.epicenter.cli`, because a terminal over SSH has no
browser to return to.

ADR-0731 left two existing pieces out of its Unbuilt line. First-party web
clients are still registered by reverse-domain id with `skipConsent: true`.
The CLI keeps each grant's refresh token in the keychain under
`so.epicenter.auth`.

## Decision

**An app's grant reaches what the person chose at consent.** ADR-0614's
repository grant stands: one grant per account, origin, and repository, the
repository named by id. The consent screen preselects the repository named
from the app's host by ADR-0722 (`whispering` for
`https://whispering.epicenter.so`), and the person can choose another,
including one shared with them, or a second repository for the same app.
Nothing selects a repository by name without that screen.

```txt
https://whispering.epicenter.so wants to read and change one repository.

  (•) whispering                 yours      named from the app's site: preselected
  ( ) whispering-work            yours
  ( ) whispering  (from Alice)   shared with you
```

**Epicenter's client is its origin, `https://epicenter.so`.** It is the one
client of the Epicenter app and its engine, and its grant reaches every
repository the person is on, because Epicenter syncs them. It accepts two
grants:

| Grant | Used by |
| --- | --- |
| Authorization code with S256 PKCE and a loopback redirect | the Epicenter app, and `epicenter auth login` on a machine with a browser |
| Device authorization (RFC 8628) | `epicenter auth login` in a terminal without a browser, and agents |

`so.epicenter` and `so.epicenter.cli` retire.

**The engine's refresh token lives in Epicenter's AppData, in a file only the
person can read,** as every desktop app's does (ADR-0731). The app and the
engine read and write the same file; no keychain item holds it.

## Consequences

- Shared repositories and a second repository for one app keep working
  under sign-in by site.
- A site that works in two repositories holds two grants, as ADR-0614 states.
- Epicenter appears on the account's page by its site, like every other app.
- The CLI signs in without a browser through the same client the app uses,
  so the account lists one grant per machine for Epicenter, not two.
- Epicenter's AppData holds a credential. Deleting it signs Epicenter and the
  engine out on that machine, and no data is lost.

## Considered alternatives

- **Reach derived from the origin (ADR-0731).** Reaches only
  `<account>/<name>`, so shared repositories and a second repository need a
  separate mechanism.
- **Keep `so.epicenter` for Epicenter.** Leaves one client that is not its
  origin, and the account's page would name Epicenter differently from
  every other app.
- **Keep `so.epicenter.cli` for the device grant.** Two clients for one
  product, and two grants on the account page for one machine.
