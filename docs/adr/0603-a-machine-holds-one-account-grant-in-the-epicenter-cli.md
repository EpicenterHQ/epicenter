# 0603. A machine holds one account grant, in the epicenter CLI

- **Status:** Proposed
- **Date:** 2026-10-17
- **Amends:** [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) at the `so.epicenter` and `so.epicenter.cli` rows of the client table and at the refused alternative's "an agent gets its own device grant with a narrower scope and target": one client, `so.epicenter`, is allowed both the loopback authorization code grant and the device grant, `so.epicenter.cli` is deleted, and an agent uses its machine's grant. [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md) at the Sign-in row's `epicenter auth login --loopback` and at "The desktop grant serves only the commands Rust runs; a terminal or an agent uses the device grant": Settings runs `epicenter auth login`, and the one grant serves Rust's commands, terminals, and agents. [ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md) at "`auth login` follows ADR-0549's two clients", "The desktop grant and a terminal's grant stay apart", "with `--desktop` added when Rust started it", the consequences that a person signed in to the desktop app signs in again for a terminal, that `--desktop` keeps agents on their own grant, and that `auth logout` signs out one of two grants, and the refused alternative that every command uses the desktop grant, which is adopted: `epicenter auth login` signs in by loopback and `epicenter auth login --device` by device code, both to the one grant every command uses. [ADR-0565](0565-a-refresh-token-keeps-its-grants-scopes-and-only-each-access-token-is-narrowed-to-its-audience.md) at "`so.epicenter` (the desktop) and `so.epicenter.cli` (terminals and agents) are separate families", "Every terminal and agent of `so.epicenter.cli`, or every Mac of `so.epicenter`", "`so.epicenter.cli` includes `openid`", "`--desktop` is the one flag for the desktop grant", and its amendment of ADR-0558 at `epicenter auth login --desktop`: a person's grants on every machine are one refresh family, and there is no `--desktop`. [ADR-0546](0546-a-folder-syncs-to-git-epicenter-so-under-its-owners-namespace-and-the-first-push-creates-it.md) at "A terminal or an agent's machine runs `epicenter login`, the device grant" and at "an agent that needs less gets its own grant with a narrower scope and target": a terminal and an agent use their machine's one grant, which `epicenter auth login` obtains by loopback and `epicenter auth login --device` by device code. [ADR-0578](0578-epicenter-hosts-no-mcp-server.md) at the `/consent` row's `so.epicenter.cli`: the device codes approved there are `so.epicenter`'s.
- **Unbuilt:** all of it: `epicenter auth login --device`, the one keychain entry per deployment, the sign-in that writes the complete grant once and revokes the grant it replaces, the refresh lock keyed to the keychain entry, the account target that carries its grant and `AccountChanged`, the `so.epicenter` registration with the device grant, and every deletion below; a deployment step that revokes the grants of `so.epicenter.cli` and removes its registration from every database that already ran the seed, because `registerFirstPartyClients` (`packages/server/src/auth/oauth-registrations.ts:75-130`) inserts and updates only the clients it declares and deletes resource links only for those; a Postgres test that a `so.epicenter` device code is sent to the consent page despite `skipConsent: true`, since that rests on `@better-auth/oauth-provider` beta internals. Implementing this record is gated on a signed-release update probe: store the grant with one signed release, update to the next, then read, refresh, and revoke it from Settings and from the `epicenter` command link. Open, pending the owner: whether desktop pages make account requests at all (see Considered alternatives).
- **Relates:** [ADR-0594](0594-a-hosted-repository-is-reached-only-by-the-person-who-owns-it.md) (a grant has no target), [ADR-0605](0605-an-app-is-an-ordinary-single-page-app-in-a-forkable-git-repository.md) (an app's build runs inside the CLI's binary, which stores the keychain entries).

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
  (`packages/cli/src/auth.ts:58`, stored in the grant at `:521` and sent at
  `:576` and `:715`), and
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
git-credential`, and an agent all read it through the CLI; no other Epicenter
code reads the entry. An installed app's build is not kept from it: the build
runs as the person inside the CLI's binary (ADR-0605).

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

**A sign-in writes the complete grant once.** It reads who approved the
grant from `/auth/oauth2/userinfo` with the tokens it was just issued, then,
under the entry's lock, writes the refresh token, scope, account, and
`signedInAt` together. Today `keepGrant` (`packages/cli/src/auth.ts:502-548`)
writes the grant with `account: null`, releases the lock, reads userinfo,
relocks, and stamps the account onto whatever the entry then holds, so a
second sign-in between the two writes would carry the first one's account.
Two entries kept a terminal's and Settings' sign-ins from meeting there; one
entry does not. A sign-in that replaces an entry holding another refresh
token revokes the replaced token on the server, as `epicenter auth logout`
does (`auth.ts:784-821`), so a displaced grant does not outlive its entry.

**The refresh lock is one per keychain entry.** Its path is derived from the
entry's service and name alone, in a per-user directory that
`EPICENTER_DATA_DIR` does not move. Today the lock is
`<dataDir>/auth/<grant>.lock` (`auth.ts:97`, `:246`;
`packages/cli/src/app-paths.ts:9`), and Rust sets `EPICENTER_DATA_DIR` for
every child it starts (`apps/epicenter/src-tauri/src/cli.rs:297`), so a
development build's CLI locks under `so.epicenter.dev` while a terminal's
locks under `so.epicenter`, and an agent may set its own. The keychain entry
depends on none of that, so with one entry two processes could refresh it
under two locks.

**An account request carries the grant it was made for.** The account
target becomes `{kind: "account", audience, grant: {principal, signedInAt}}`,
the principal being the stored grant's `account.id`. `epicenter send`
refuses with `AccountChanged` when the stored grant's principal or
`signedInAt` differs, and `packages/auth/src/desktop-account-auth.ts`
treats `AccountChanged` as it treats `NoAccountToken`: it reads the grant
again and rethrows. Today the target names only the audience
(`AccountTarget::Account`, `cli.rs:874-879`), the page builds its `Account`
from its last read of the grant (`desktop-account-auth.ts:119-169`), and it
notices a new grant only on window focus (`:84-88`) or on `NoAccountToken`.
With one grant, a terminal's or an agent's sign-in replaces the grant under
an open window, whose next request would carry the new person's token while
the page still shows the old one. This is the inverse of the AI target,
which names only its connection and loses `EndpointChanged`: a principal
keys what the page holds (its `Account`, its `principalId`, and the data and
publications under them), so a request sent as another person lands in the
wrong account; an endpoint keys nothing the page holds.

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
                                         the <grant> prefix of the keychain entry's name;
                                         the lock under the data directory, and keepGrant's second write
packages/cli/src/app-paths.ts            the <dataDir>/auth/<grant>.lock line
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
with the code they test. A machine's `desktop <origin>` and
`device <origin>` entries still hold live refresh tokens, so the first write
of the one grant revokes each one it finds, as `auth logout` does, and
removes it. That is the whole migration: nothing else reads the old entries.

Deleting the `so.epicenter.cli` row from code does not delete the client
from a database the seed already ran against, so a deployment step revokes
its grants and removes its registration (Unbuilt).

## Consequences

- One sign-in per machine. Signing in from Settings signs in every terminal
  and agent on that Mac, `epicenter auth login` in a terminal signs in the
  app, and `epicenter auth logout` anywhere signs all of them out.
- Agents and terminals no longer get a separate, narrower, or separately
  revocable grant. A process that can run `epicenter` as the person gets the
  same tokens as the app. ADR-0558 already said `--desktop` was no boundary
  against a local process; an agent that must not reach the account must not
  run as the person.
- **The controlling tradeoff: a local credential incident is an incident on
  every machine.** `epicenter auth token` (`packages/cli/src/auth-commands.ts:132`)
  prints a bearer access token to any process running as the person, and
  nothing revokes an agent's use separately from the app's. A person's
  grants on every machine are one refresh family, `so.epicenter` for that
  person (ADR-0565), so a refresh replayed after the 60-second reuse window,
  on any of ADR-0565's paths, ends the family: the app on every Mac, every
  terminal, and every agent ask for a new sign-in, and a headless agent
  waits for a person to approve a device code. The likeliest replayer is an
  agent killed mid-refresh: `finishBeforeExit` holds the process for a stop
  signal (`auth.ts:26-29`) but not for `SIGKILL`, which harnesses send on a
  timeout. Before, a terminal's replay ended only the `so.epicenter.cli`
  family. The server's family invalidation is not atomic either
  (`invalidateRefreshFamily`, `@better-auth/oauth-provider` `1.8.0-beta.0`
  `dist/introspect-CEo9Q06v.mjs:1628-1645`, whose own comment names the
  race): a rotation between its two deletes can leave a fresh refresh token
  alive, so "a replay ends every grant" is the intent, not a guarantee, with
  one client or two.
- Every program on a machine now refreshes one entry, under the one lock
  keyed to that entry, rereading it inside the lock (ADR-0549), so they take
  turns. They take turns only because the lock no longer lives under
  `EPICENTER_DATA_DIR`; with today's lock path a development build and a
  terminal would race on one entry.
- A terminal's or an agent's sign-in replaces the grant an open window is
  using. The window's next account request is refused with `AccountChanged`,
  and it reads the new grant, rather than sending as the new person.
- The consent page shows the client's name (`client_name`,
  `apps/api/ui/src/routes/consent/+page.svelte:74`), so a device code reads
  "Epicenter" rather than "Epicenter CLI", a weaker hint against a phished
  code. The page keeps ADR-0549's "Only approve a code you just started".
- One shared entry is reached by whichever binary runs `epicenter`: the
  release binary through the command link, `bun` running the CLI from source
  in development, and agents running either. Each alternation, and each
  update that changes the binary's signature, may raise a macOS keychain
  prompt, from a headless agent's run as easily as from Settings (ADR-0556
  already says an unsigned development build may prompt). This is inference;
  the signed-release update probe in Unbuilt is what settles it.
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
- **Keep two refresh families so a local incident stays local.** That is the
  one thing the split bought, and it costs the second sign-in, the second
  client, and the `grant` argument this record deletes. It is refused here;
  the cost of refusing it is the first consequence.
- **No staleness check on account requests.** A window would send as
  whoever last signed in on the machine until it next gained focus.
- **Open, pending the owner: desktop pages make no account requests.** The
  profile read, `GET /api/repos`, and connecting a folder would become fixed
  `epicenter` commands, which deletes `account_send`, `AccountAudience`, the
  page's `via()`, and the stale-account case by construction, at the cost of
  one command per account API instead of a general proxy. This record does
  not decide it; the `AccountChanged` check stands until the owner does.
