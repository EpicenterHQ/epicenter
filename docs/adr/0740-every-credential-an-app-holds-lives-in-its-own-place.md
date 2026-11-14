# 0740. Every credential an app holds lives in its own place

<!-- doc-path-check: ignore-file (cites code that moved since) -->

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amends:** [ADR-0731](0731-every-app-signs-in-as-its-site.md) at "how the app proves it: desktop: a refresh token" and the shell's file holding only the refresh token: a web app holds a refresh token too, and the desktop file also holds the person's provider API keys; [ADR-0701](0701-apps-run-as-separate-programs.md) at decision 84's "the refresh token stays in the keychain" and "API keys are keychain entries too": both are in one file in the app's AppData; [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) at "A browser app keeps its access token in `localStorage` and holds no refresh token" and its renewal by navigating with `prompt=none`: a browser app keeps a rotated refresh token and renews without navigating.
- **Amended by:** [ADR-0764](0764-reaching-a-model-is-epicenter-ais-alone-in-the-openai-vocabulary.md) at who holds the provider keys: `@epicenter/ai` writes and reads them in the desktop credentials file through the shell, and on the web keeps them in the browser's storage.
- **Relates:** [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) (a refresh token per grant renews access without leaving the page), [ADR-0565](0565-a-refresh-token-keeps-its-grants-scopes-and-only-each-access-token-is-narrowed-to-its-audience.md) (refresh families and reuse detection), [ADR-0732](0732-a-grant-reaches-what-the-person-chooses-at-consent.md) (the engine's token in Epicenter's AppData).
- **Unbuilt:** the web refresh token in origin storage; removing `automaticRenewal` and the `prompt=none` renewal from `packages/account/src/browser-oauth.ts`.

## Context

Desktop apps keep credentials in the OS keychain through `keyring`
(`packages/tauri-epicenter-account/src/keychain.rs`, one entry per name
under the bundle identifier as the service). Whispering keeps both of its
provider connections, keys included, in one entry named `connections`
(`apps/whispering/src/lib/platform/services.tauri.ts`). Vocab keeps one entry
per connection, named by its id
(`apps/vocab/src/lib/connections.tauri.ts`).
[ADR-0731](0731-every-app-signs-in-as-its-site.md) already moved the desktop
refresh token out of the keychain into a file in the app's AppData, because
the file keychain prompts a rebuilt binary and one store serves every
platform.

A web app holds no refresh token. `createBrowserOAuth` in
`packages/account/src/browser-oauth.ts` keeps access tokens in `localStorage`
and, when the earliest is within ten minutes of expiry, navigates the page to
the authorize endpoint with `prompt=none` (`automaticRenewal`, on by
default). The navigation unloads the page, so work held only in page memory,
such as a browser recording, is lost
([ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md)).
ADR-0549 refused browser refresh tokens over a cross-tab race in 2026-08:
a duplicate refresh at a reuse interval of 0 ended the person's refresh
family. The reuse interval is now 60 seconds
(`REFRESH_TOKEN_REUSE_INTERVAL_SECONDS` in
`packages/server/src/auth/oauth-policy.ts`).

## Decision

**Every credential an app holds lives in its own place.**

| Where the app runs | Its place | What it holds |
| --- | --- | --- |
| Desktop | one file in the app's AppData, readable only by the person (mode `0600`) | the refresh token and the person's provider API keys |
| Web | the origin's `localStorage` | the access tokens and a rotated refresh token |

- **`keyring` leaves the apps.** No app reads or writes the keychain. The
  shell still sends each connection's requests and adds its key (Vocab's
  `connectionFetch`), reading the key from the file.
- **A web app renews by refreshing, never by navigating.** It spends the
  refresh token at the token endpoint and stores the rotated one. The
  server's reuse detection (ADR-0565) ends the family when a spent token is
  replayed after the reuse interval. `automaticRenewal` and the `prompt=none`
  renewal are removed.

## Consequences

- Renewal never unloads the page, so a recording or an unsaved form survives
  it.
- Tabs share the refresh token through storage; a second tab spending the
  same token within 60 seconds is not treated as a replay.
- A script on the origin can read a refresh token, which lives longer than an
  access token. A stolen one works until it is spent or revoked, and reuse
  detection ends the family when the thief and the app both spend it.
- `offlineDetach` still skips web clients
  (`packages/server/src/auth/offline-detach.ts`), so a web app's refresh token
  ends with the epicenter.so session that approved it.
- A desktop app's credentials are readable by any program running as the
  person, without the prompt the keychain would show. Disk encryption covers
  a stolen disk.
- Deleting an app's AppData signs it out and forgets its provider keys.

## Considered alternatives

- **The keychain for API keys, a file for the refresh token.** Two stores per
  app, and the keychain's prompts for a rebuilt binary remain.
- **Keep `prompt=none` renewal.** Each renewal unloads the page and depends on
  the epicenter.so cookie at that moment.
- **A refresh token in `sessionStorage`.** Every new tab signs in again.
