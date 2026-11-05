# 0783. A secret lives in the app's credentials file, and is read by the request that uses it

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0778](0778-a-page-connects-once-and-then-reads-synchronously.md) at "A secret is read by the action that uses it": a connection's key and the account's refresh token are read from the app's credentials file, not the keychain, and there is nothing to keep after a first read.
- **Relates:** [ADR-0740](0740-every-credential-an-app-holds-lives-in-its-own-place.md) (every credential an app holds lives in its own place, which this keeps), [ADR-0731](0731-every-app-signs-in-as-its-site.md) (the desktop refresh token as a file in AppData).
- **Unbuilt:** the shell reading the credentials file when it sends a request that needs a key or a token; removing `keyring` from `packages/tauri-epicenter-account`; the rest of ADR-0740's Unbuilt line.

## Context

ADR-0778 said a connection's key is read "from the keychain when a request
is sent", the shell keeping it after the first read, and that the account's
refresh token "stays in the keychain". ADR-0740, accepted the day before,
had already moved every desktop credential out of the keychain into one
file in the app's AppData, readable only by the person, because the
keychain prompts a rebuilt binary and one file serves every platform. The
two disagreed on where a secret lives; they agreed that it never reaches the
page.

## Decision

**A secret lives where ADR-0740 put it, and is read by the request that uses
it.** On the desktop, a connection's key and the account's refresh token are
in the app's credentials file in AppData. The shell reads the file when it
sends a request that needs one, and adds the key or the token to that
request; the page never holds either. No app reads the keychain, so no read
prompts and none is kept. What is not secret, who is signed in and which
endpoint a key belongs to, is a setting (ADR-0778).

## Consequences

- No keychain prompt at launch or at a first request, and none after a
  rebuild.
- The connection's first paint never waits on a secret.
