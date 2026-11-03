# 0720. You sign in a machine, not an app

- **Status:** Accepted (2026-11-03)
- **Date:** 2026-11-03
- **Amends:** [ADR-0701](0701-apps-run-as-separate-programs.md) at decision 84 (one native client per app, `so.epicenter.<app>.native`, each with its own refresh token): every first-party program on a machine shares one sign-in; [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) at its client table's desktop and CLI rows: `so.epicenter` is the one first-party client for a machine and accepts both the loopback authorization code and device authorization, and `so.epicenter.cli` retires.
- **Relates:** [ADR-0565](0565-a-refresh-token-keeps-its-grants-scopes-and-only-each-access-token-is-narrowed-to-its-audience.md) (each access token is narrowed to one audience), [ADR-0547](0547-every-repository-has-one-owner-namespace-and-a-person-is-a-namespace-of-one.md) (namespaces), [ADR-0606](0606-a-third-party-browser-app-signs-in-by-a-client-metadata-document-on-its-own-origin.md) and [ADR-0614](0614-a-browser-app-is-identified-by-its-origin.md) (third-party grants), [ADR-0718](0718-epicenters-machinery-on-a-machine-lives-in-a-hidden-home-every-program-reads.md) (`~/.epicenter`), [ADR-0719](0719-every-change-to-the-data-model-is-checked-against-eight-principles.md) (principles).
- **Unbuilt:** all of it: the `so.epicenter.session` keychain item; `~/.epicenter/session.lock`; `account` and `server` in `~/.epicenter/settings.md`; device registration and the device list on the server; device authorization on `so.epicenter`; rewriting `epicenter-account` (`packages/tauri-epicenter-account`) and the CLI's sign-in (`packages/cli/src/auth.ts`) over the shared session; removing `so.epicenter.whispering.native`, `so.epicenter.vocab.native` (`NATIVE_APPS` in `apps/api/worker/oauth-registrations.ts`) and `so.epicenter.cli`.

## Context

Each program on a machine signs in on its own today.

```txt
program            client                          refresh token kept in
Whispering         so.epicenter.whispering.native  keychain, account:<origin>
Vocab              so.epicenter.vocab.native       keychain, account:<origin>
Epicenter          so.epicenter                    keychain
epicenter CLI      so.epicenter.cli (device grant) keychain service so.epicenter.auth, one entry per grant
                   so.epicenter (desktop grant)    same service, used only by commands Rust runs
```

ADR-0701's decision 84 made each standalone app its own native client
(`packages/tauri-epicenter-account/README.md`): the system browser returns to
a loopback listener with S256 PKCE (RFC 8252), and the refresh token stays in
that app's keychain entry. `packages/cli/src/auth.ts` holds the CLI's two
grants under `so.epicenter.auth` and refreshes under a lock file in
`<so.epicenter AppData>/auth/<grant>.lock`, because the server rotates refresh
tokens: inside the 60-second reuse interval a repeated refresh gets the same
answer, and a replay after it ends every grant of that client for the person
(ADR-0565).

A person with Whispering, Vocab, Epicenter, and the CLI signs in four times on
one computer, holds four refresh tokens, and signs out four times.

## Decision

**A machine has one sign-in, and every first-party program on it uses it.**

```txt
keychain                    so.epicenter.session        the refresh token (development: so.epicenter.session.dev)
~/.epicenter/settings.md    account: braden             who this machine is signed in as; not secret
                            server: https://api.epicenter.so
~/.epicenter/session.lock   held by whichever program refreshes
```

- **Whichever first-party program signs in writes the session.** Whispering,
  Epicenter, or `epicenter auth login` each sign in through the one client
  `so.epicenter`: a desktop program by the loopback authorization code with
  PKCE, a terminal or an agent by device authorization (RFC 8628). Every other
  first-party program on the machine finds the session and is signed in.
- **Signing out anywhere signs the machine out.** The program deletes the
  keychain item and the `account` key, asks the server to revoke the device,
  and every app shows that the machine is signed out.
- **A program asks for an access token for one audience.** It refreshes under
  `~/.epicenter/session.lock`, rereads the keychain item inside the lock, and
  keeps the access token in memory; no program keeps its own refresh token.
  Each access token is narrowed to one audience, such as the API for
  inference (ADR-0565).
- **The server sees devices, not apps.** A machine is one entry under the
  account, named by the person ("Braden's MacBook") and revocable in one
  place. Each request still names the calling app for usage and rate limits;
  the name grants nothing.
- **The session is a convention, not a process.** A keychain item, a lock,
  and a settings note, read the same way by the Rust crate the apps share and
  by the CLI. An app signs in with Epicenter not installed.
- **One account per machine and environment.** Work and personal data are
  namespaces one account belongs to (ADR-0547); a second person uses their own
  operating-system user and home directory.
- **Third-party apps never inherit the session.** A third-party app signs in
  as its own client, named by its site's origin (ADR-0606, ADR-0614), and the
  person approves each one.

## Consequences

- One sign-in and one sign-out per machine. The four refresh tokens become
  one, and the per-app native clients and `so.epicenter.cli` leave
  `oauth-registrations.ts`.
- Any program running as the person can run `epicenter` and obtain an access
  token, as with `gh auth token` or `gcloud auth print-access-token`. Tokens
  for one audience, their lifetime (ADR-0549), and the server's device list
  bound what a stolen token reaches and how long.
- A refresh replayed after the reuse interval now signs out the whole machine
  rather than one app, so the lock and the reread inside it carry every
  first-party program, not only the CLI.
- If several accounts per machine become necessary, the additive path follows
  Dropbox and OneDrive: one root per account (`~/Epicenter (Work)`) with its
  own machine home and its own session. Every path already derives from the
  environment and the slug, so the account becomes a third input.

## Considered alternatives

- **One sign-in per app (today).** Four sign-ins, four sign-outs, and four
  refresh tokens on one computer for one person.
- **A broker process held by Epicenter that issues tokens to apps.** An app
  would need Epicenter installed and running to sign in, against an app
  working alone.
- **A `.epicenter` nested in each account's root.** Mixes machinery into the
  data folder, for a need namespaces already meet.
- **Several accounts per machine now.** No current use needs it; namespaces
  cover work and personal data.
