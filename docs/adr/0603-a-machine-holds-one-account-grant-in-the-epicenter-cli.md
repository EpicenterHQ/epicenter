# 0603. A machine holds one account grant, in the epicenter CLI

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) at the `so.epicenter` and `so.epicenter.cli` rows of the client table and at the refused alternative's "an agent gets its own device grant with a narrower scope and target": one client, `so.epicenter`, is allowed both the loopback authorization code grant and the device grant, `so.epicenter.cli` is deleted, and an agent uses its machine's grant. [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md) at the Sign-in row's `epicenter auth login --loopback` and at "The desktop grant serves only the commands Rust runs; a terminal or an agent uses the device grant": Settings runs `epicenter auth login`, and the one grant serves Rust's commands, terminals, and agents. [ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md) at "`auth login` follows ADR-0549's two clients", "The desktop grant and a terminal's grant stay apart", "with `--desktop` added when Rust started it", the consequences that a person signed in to the desktop app signs in again for a terminal, that `--desktop` keeps agents on their own grant, and that `auth logout` signs out one of two grants, and the refused alternative that every command uses the desktop grant, which is adopted: `epicenter auth login` signs in by loopback and `epicenter auth login --device` by device code, both to the one grant every command uses. [ADR-0565](0565-a-refresh-token-keeps-its-grants-scopes-and-only-each-access-token-is-narrowed-to-its-audience.md) at "`so.epicenter` (the desktop) and `so.epicenter.cli` (terminals and agents) are separate families", "Every terminal and agent of `so.epicenter.cli`, or every Mac of `so.epicenter`", "`so.epicenter.cli` includes `openid`", "`--desktop` is the one flag for the desktop grant", and its amendment of ADR-0558 at `epicenter auth login --desktop`: a person's grants on every machine are one refresh family, and there is no `--desktop`. [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) at "an agent that needs less gets its own grant with a narrower scope and target": an agent uses its machine's grant. [ADR-0578](0578-epicenter-hosts-no-mcp-server.md) at the `/consent` row's `so.epicenter.cli`: the device codes approved there are `so.epicenter`'s.
- **Unbuilt:** all of it: `epicenter auth login --device`, the one keychain entry per deployment, the `so.epicenter` registration with the device grant, and every deletion below.
- **Relates:** [ADR-0594](0594-a-hosted-repository-is-reached-only-by-the-person-who-owns-it.md) (a grant has no target), [ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md) (approval guards against remote code, not local processes), [ADR-0604](0604-a-page-sends-through-one-send-that-keeps-desktop-secrets-in-the-epicenter-cli.md) (a desktop page holds no secret).

## Context

Line numbers below are at `e9027cc744`.

A Mac signed in to Epicenter holds two account grants, both kept by the
`epicenter` CLI in the keychain service `so.epicenter.auth`
(`AUTH_KEYCHAIN_SERVICE`, `packages/cli/src/secrets.ts:22`), one entry each,
named `<grant> <origin>` (`entryName`, `packages/cli/src/auth.ts:195-196`):

| `GrantKind` | Client | Obtained by | Used by |
| --- | --- | --- | --- |
| `desktop` | `so.epicenter`, loopback authorization code | `epicenter auth login --desktop`, which Settings runs | every command Rust runs for a page or for Settings |
| `device` | `so.epicenter.cli`, device grant | `epicenter auth login` | a terminal, `epicenter auth git-credential`, an agent |

`GrantKind` and `AUTH_CLIENTS` are `packages/cli/src/auth.ts:49-55`. Rust
selects the desktop grant by appending `--desktop` to every child it starts
(`Invocation.desktop`, `Invocation::desktop`, and the push in
`Invocation::run`, `apps/epicenter/src-tauri/src/cli.rs:283-342`; callers
at `cli.rs` and `apps/epicenter/src-tauri/src/history.rs:53`).
`apps/api/worker/oauth-registrations.ts:74-112` registers both clients.

ADR-0549, ADR-0546, and ADR-0558 kept the grants apart so that an agent
would get its own grant, narrower than the app's and revoked on its own. The
code enforces none of that:

- Both clients request one scope string, `SCOPE`
  (`packages/cli/src/auth.ts:58`, sent at `:521`, `:576`, and `:715`), and
  both registrations list the same six scopes. The consent page lists the
  requested scopes and offers no choice among them
  (`apps/api/ui/src/lib/auth/GrantRequest.svelte`).
- The one narrowing a person could pick was the grant's target
  (`grantTarget`, `packages/server/src/auth/grant-target.ts`), which
  ADR-0594 deletes.
- `--desktop` is an argument any local process can pass
  (`packages/cli/src/parse.ts:79-81`), as ADR-0558's consequences already
  say.
- Revoking one grant without the other needs the account pages' list of
  grants, which ADR-0549's Unbuilt line names.

What the split does cost: a person signed in to the app signs in again with
`epicenter auth login` before a terminal's `git` reaches the Git audience
(ADR-0558), `auth status` and `auth logout` juggle two grants, and every
command takes a `grant` argument.

## Decision

**Each machine holds one account grant, and every program on it uses that
grant.** The `epicenter` CLI keeps it in one keychain entry per deployment,
named by the deployment's origin, under `so.epicenter.auth`. Settings, the
commands Rust runs for a page, a terminal, `git` through `epicenter auth
git-credential`, and an agent all read it through the CLI; nothing else reads
the entry.

**The grant is obtained two ways, as one client, `so.epicenter`.**

```txt
epicenter auth login            authorization code, S256 PKCE, offline_access,
                                received on http://127.0.0.1:<port>/callback; Settings runs it
epicenter auth login --device   device authorization (RFC 8628); for a machine whose browser
                                is elsewhere, such as over SSH
```

Both request `SCOPE` for the `api` and `git` audiences and write the same
entry; signing in again replaces it. The `so.epicenter` row in
`buildFirstPartyClients` lists the grant types `authorization_code`,
`refresh_token`, and `urn:ietf:params:oauth:grant-type:device_code`, and
keeps `skipConsent: true` and its loopback redirect.

**A device code is still approved on the consent page every time.**
`@better-auth/oauth-provider` `1.8.0-beta.0` marks every device request
`requireConsent: true` (`dist/index.mjs:136`), and the authorization flow
checks it before the client's `skipConsent`
(`dist/authorize-92EtLsBi.mjs:5954`, `:5987`). The page shows the code and
"Only approve a code you just started" (ADR-0549) whatever the client's
registration says. Loopback sign-in shows no consent page, as the desktop's
does today.

**A browser tab keeps its own grant.** A browser app's origin holds one
access token in `localStorage` (ADR-0549's browser row); a tab has no CLI to
ask.

**Deleted:**

```txt
packages/cli/src/auth.ts                 GrantKind; AUTH_CLIENTS becomes the one client id, so.epicenter;
                                         the <grant> prefix of the keychain entry's name
packages/cli/src/parse.ts                --desktop, and the grant field of an Invocation
packages/cli/src/{cli,auth-commands,repository-commands,history-commands}.ts
                                         the grant argument every command threads
apps/epicenter/src-tauri/src/cli.rs      Invocation.desktop, Invocation::desktop, the --desktop push in run,
                                         every .desktop() call, and AuthStatus's list of grants
apps/epicenter/src-tauri/src/history.rs  its .desktop() call
apps/api/worker/oauth-registrations.ts   the so.epicenter.cli row
```

`epicenter auth status` reports the one grant, and `epicenter auth logout`
revokes and removes it. Tests that name `so.epicenter.cli` or `--desktop` go
with the code they test. Nothing is migrated: a development machine's
`desktop <origin>` and `device <origin>` entries are no longer read, and one
sign-in writes the new entry.

## Consequences

- One sign-in per machine. Signing in from Settings signs in every terminal
  and agent on that Mac, `epicenter auth login` in a terminal signs in the
  app, and `epicenter auth logout` anywhere signs all of them out.
- Agents and terminals no longer get a separate, narrower, or separately
  revocable grant. A process that can run `epicenter` as the person gets the
  same tokens as the app. ADR-0558 already said `--desktop` was no boundary
  against a local process; an agent that must not reach the account must not
  run as the person.
- A person's grants on every machine are one refresh family, `so.epicenter`
  for that person (ADR-0565). A replay outside the 60-second reuse window,
  on any of ADR-0565's paths, ends the one grant everywhere: the app on every
  Mac, every terminal, and every agent ask for a new sign-in, and a headless
  agent waits for a person to approve a device code. Before, a terminal's
  replay ended only the `so.epicenter.cli` family.
- The app and a terminal on one machine now refresh one token. The CLI
  already refreshes under a file lock beside the stored token and rereads it
  inside the lock (ADR-0549), so they take turns rather than race.
- One OAuth client to register, seed, and test, and one grant per machine in
  the account pages' list once it exists.

## Considered alternatives

- **Two grants, as ADR-0558 decided.** The narrowing and separate revocation
  they promised are not enforced (one `SCOPE`, a parseable `--desktop`, a
  target ADR-0594 deletes, no grant list), and the split costs a second
  sign-in and a second refresh family.
- **Two clients, with every command using the desktop grant when the machine
  holds one.** Still two registrations and two sign-in flows for one grant
  in use.
- **Device code only.** One flow, but a person would copy a code inside
  their own app, as ADR-0558 refused.
- **Loopback only.** No sign-in on a machine whose browser is elsewhere,
  such as over SSH.
- **`so.epicenter.cli` as the one client.** The app's own sign-in would show
  the person "Epicenter CLI", and that client has no loopback redirect
  registered.
- **A narrower grant for an agent through `scope` on refresh or token
  exchange.** ADR-0549 refused both: Better Auth narrows the stored grant on
  refresh and has no token exchange.
