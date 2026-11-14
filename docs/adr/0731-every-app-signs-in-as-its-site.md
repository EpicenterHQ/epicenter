# 0731. Every app signs in as its site

<!-- doc-path-check: ignore-file (cites code that moved since) -->

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Supersedes:** [ADR-0720](0720-you-sign-in-a-machine-not-an-app.md) (you sign in a machine, not an app): separately signed programs cannot share one keychain item without prompts, and the broker that could share it cannot tell which program is asking.
- **Amends:** [ADR-0719](0719-every-change-to-the-data-model-is-checked-against-eight-principles.md) at principle 6, "one sign-in serves every first-party program on the machine": each app signs in as its site, and a machine groups those sign-ins; [ADR-0701](0701-apps-run-as-separate-programs.md) at decision 84 (`so.epicenter.<app>.native`): a desktop app's client is its site's origin; [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) at its client table: every app's client is its origin, `so.epicenter` is the Epicenter app and its engine, and `so.epicenter.cli` retires; [ADR-0606](0606-a-third-party-browser-app-signs-in-by-a-client-metadata-document-on-its-own-origin.md) at "Native app identity remains a separate implementation question": a native app is its origin with a loopback redirect.
- **Amended by:** [ADR-0732](0732-a-grant-reaches-what-the-person-chooses-at-consent.md) at "What an app can reach derives from its origin" and the client `so.epicenter`: a grant reaches the repository chosen at consent (ADR-0614), and Epicenter's client is its origin, `https://epicenter.so`, which also takes device authorization; [ADR-0740](0740-every-credential-an-app-holds-lives-in-its-own-place.md) at "how the app proves it: desktop: a refresh token" and the desktop file's contents: a web app keeps a rotated refresh token and never renews by navigating, and the desktop file also holds the person's provider API keys.
- **Relates:** [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) (an app is identified by its origin), [ADR-0594](0594-a-hosted-repository-is-reached-only-by-the-person-who-owns-it.md) (a grant names an account, an origin, and a repository), [ADR-0633](0633-apps-open-local-data-before-connecting-services.md) (local data first), [ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md) (names from the host), [ADR-0730](0730-everything-not-derived-from-an-apps-site-is-one-of-five-stored-kinds.md) (five stored kinds).
- **Unbuilt:** all of it: origin client ids for desktop apps; the account's per-origin grant and its derived reach; the computer's name on a native grant and "Sign out this Mac"; the desktop refresh token as a file in AppData; the site supplied by the runtime; `connectAccount()` without identity options; removing `so.epicenter.whispering.native`, `so.epicenter.vocab.native` and `so.epicenter.cli` (`apps/api/worker/oauth-registrations.ts`) and the `keyring` use in `packages/tauri-epicenter-account`.

## Context

ADR-0720 gave a machine one sign-in: a keychain item `so.epicenter.session`
read by every first-party program, a lock in `~/.epicenter`, and a device
registered with the server. Third-party apps were to sign in as their own
origin clients.

A spike on 2026-11-04 tested the shared item on macOS. The data-protection
keychain shares items only within one developer team, and a command-line tool
cannot easily carry the entitlement (an ad-hoc signed probe got `-34018`). The
file keychain, which `keyring` and `Bun.secrets` use, trusts the binary that
created an item: a rebuilt `bun build --compile` binary has a new code hash and
is prompted, and after a second binary rewrote the item neither could read it
silently. Refresh tokens rotate on every refresh (ADR-0565), so several
writers hit this every time. A broker (only the engine holds the token; apps
run `epicenter auth token`) avoids the keychain problem but cannot tell which
program is calling, so its consent list would trust a name the caller chose,
and an app without the engine could not sign in, against principle 6.

The web already signs in by origin. `packages/account/src/browser-oauth.ts`
holds no refresh token: it renews by navigating to the authorize endpoint with
`prompt=none`, and the server answers from the browser's epicenter.so session
and the grant it remembers. Each app still passes `clientId`, `resources`,
`scope`, and `accountManagement` by hand (`apps/todos/src/lib/auth.ts`,
`apps/whispering/src/lib/platform/auth.ts`, and five more).

## Decision

**Every app, on the web and on the desktop, signs in as its site's origin.**
The origin is the OAuth client id (ADR-0614). A web app returns to its page; a
desktop app opens the system browser and returns to a loopback listener with
S256 PKCE (RFC 8252). The Epicenter app and its engine are one product with one
client, `so.epicenter`, whose grant syncs every folder; the CLI uses it.

**The account asks once per app and remembers the decision.** The consent
screen is the account's own page, the same for the web and the desktop, for
first-party and third-party apps alike. It names the app by its site and says
what it can reach. The server keeps the grant (the person and the origin); a
later sign-in from that origin finds it and skips the screen. Nothing on the
machine records which apps were allowed.

**What an app can reach derives from its origin.** A grant covers the app's
own repository and documents, named from its host (ADR-0722), and inference.
There are no scope strings in app code. Only the Epicenter app's grant reaches
every repository, because it syncs them.

**An app learns its site from the runtime, never as an argument.** On the web
it is `location.origin`; on the desktop the shell supplies it from the bundle
identifier, as it already derives the Data root. `connectAccount()` takes no
identity options. A script that acts on another app names it (`open(handle)`);
an app acting as itself names nothing.

**Each credential is a cache of the decision above it.**

```txt
decision                     remembered as                          asked
who you are                  the browser's session at epicenter.so  sign in
what you let this app do     the grant on the server                "Allow", once per app
how the app proves it        desktop: a refresh token               never
what one request may do      an access token, one audience          never
```

Revoking a decision invalidates everything below it.

**On the desktop the shell holds the refresh token, in a file only the person
can read, in the app's AppData.** The page never sees a token; it gets
`account.fetch`, which the shell relays (`packages/account/src/tauri.ts`). One
binary reads and writes each file, so no program prompts another.

**A machine groups its sign-ins by the computer's name.** A native grant
records the name of the computer it was made on. The account's page lists
"Braden's MacBook: Whispering, Tabs, Zhongwen", and "Sign out this Mac"
revokes those grants. The name grants nothing.

## Consequences

- An app signs in without Epicenter installed, and the broker, `session.lock`,
  `settings.md`'s account and server, the shared keychain item, and the
  separate design for native identity are not built.
- The first sign-in of each app opens the browser once. With the person
  already signed in at epicenter.so it is one click per app, once.
- A machine holds one refresh token per signed-in app, and each app rotates
  only its own; nothing coordinates refreshes across programs.
- A loopback redirect does not prove which program is asking: a program
  running as the person can claim any origin. The same holds for every
  same-user design considered; access tokens for one audience, their lifetime
  (ADR-0549), rotation with reuse detection, and the grant list bound what a
  stolen token reaches.
- A file is readable by any program running as the person without the prompt
  the keychain would show. Disk encryption covers a stolen disk.
- Two apps on one machine can be signed in as different accounts.
- Two computers with the same name group together on the account page until
  one is renamed.

## Considered alternatives

- **One shared keychain item (ADR-0720).** Fails across separately signed
  binaries on macOS, as above.
- **A broker in the engine.** Works on every platform, but needs the engine to
  sign in and has no way to identify its caller, so per-app consent would be a
  list of names callers chose.
- **The keychain per app.** Works once each item has one reader; kept out to
  hold one store across platforms, with no Windows size limit and no Linux
  Secret Service fallback, at the cost of the keychain's prompt for other
  programs.
- **First-party apps approved without a screen.** Saves one click per app and
  leaves the account's list of apps with access less honest.
