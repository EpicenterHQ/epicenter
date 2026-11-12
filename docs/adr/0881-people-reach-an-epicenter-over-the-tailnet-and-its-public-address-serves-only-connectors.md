# 0881. People reach an Epicenter over the tailnet, and its public address serves only connectors

- **Status:** Superseded
- **Date:** 2026-11-12
- **Superseded by:** [ADR-0883](0883-an-epicenter-is-its-git-repositories-and-serve-and-its-host-keeps-runs-and-guards-them.md), the same day: the public listener served only connectors its owner does not use, and its approval needed a tailnet a hosted Epicenter would not have, so it was removed.
- **Amends:** [ADR-0871](0871-a-public-address-signs-people-in-with-a-passkey-and-connectors-in-with-oauth.md), withdrawing how people sign in (passkeys, invites, sessions, `/.sign-in`), the UIs and launcher on the public address, where a connector is approved, the `public` and `publicPort` fields, and revoking a person. Its OAuth, CIMD, scopes, grant generations and revocation stand. Also [ADR-0849](0849-your-server-is-one-always-reachable-computer-that-runs-named-actions.md), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md), [ADR-0868](0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md) and [ADR-0879](0879-an-action-may-yield-values-while-it-runs-and-only-its-return-is-the-answer.md), where each described sign-in at the public address.
- **Relates:** [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (the private listener trusts the tailnet), [ADR-0868](0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md) (`EPICENTER.md`), [ADR-0840](0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md) (one person's software).

## Context

ADR-0871 opened a public address for two kinds of caller: Claude's and
ChatGPT's connectors, which reach an Epicenter from their companies' servers,
and a person's browser off the tailnet, which signed in with a passkey. The
second is about 700 lines: passkey registration and sign-in, invites, sessions,
the sign-in page, and the session checks on every public route. All of it faces
the internet.

The owner's phone and computers run Tailscale and reach the private listener
with no sign-in. The public address itself comes from Tailscale Funnel, so the
computer running `serve` needs Tailscale whatever the phone does. Passkeys
spared Tailscale only on a person's devices, and nobody used them.

A person without Tailscale is better served later by a hosted relay, whose
sign-in belongs to hosted accounts at its edge, not to each `serve`.

A connector still needs a person to approve it. Measured 2026-11-12 on Better
Auth 1.8.0-beta.7: the authorize endpoint redirects a browser with no session
to a login page given as a whole URL on another origin, with the request
signed. A listener in the same process can then approve it through Better
Auth's consent endpoint with a session made for the approval, and the code it
returns exchanges and refreshes. A tampered request is refused. Deleting the
approval's session before the exchange breaks it; deleting it after does not
affect refresh.

## Decision

**People reach an Epicenter only over the tailnet. The public address answers
only what a connector needs, and a connector is approved on a page only the
tailnet reaches.**

```md
---
port: 4747
connectors:
  url: https://studio.tail0f84e1.ts.net:10000
  port: 4757
  tailnet: https://studio.tail0f84e1.ts.net:4747
---
```

`connectors` is optional and whole: absent, there is no public listener; present,
it has all three fields. `url` is the public address a tunnel serves, `port`
the one on `127.0.0.1` the tunnel forwards to, and `tailnet` the private
listener's address as the tailnet reaches it, where approvals happen. Each is
checked when the marker is read, with a message naming the field.

**On the public listener:**

| Path | Needs |
| --- | --- |
| `GET /.well-known/oauth-protected-resource` | nothing: RFC 9728 metadata |
| `GET /.well-known/oauth-authorization-server` | nothing: RFC 8414 metadata |
| `GET /oauth2/authorize` | nothing: redirects to `<tailnet>/.allow` |
| `POST /oauth2/token`, `/revoke`; `GET /jwks` | what OAuth asks of a connector |
| `POST /` | a connector's bearer token: MCP |

Anything else is 404: no UI, launcher, action route, or page. The issuer is
`url` itself, with no path: the `.` that keeps the server's own paths clear of
app names (ADR-0864) has nothing to keep them clear of here, so the paths are
Better Auth's own and the metadata sits where RFC 8414 puts it for an issuer
without a path. `/.allow` keeps its `.`, since the private listener serves
apps.

**A connector is approved on the private listener.** Every authorization goes
to `<tailnet>/.allow` with Better Auth's signed query; the router sets
`prompt=consent`, so a stored consent never finishes one silently. The page
shows the connector as ADR-0871's did. Its approval posts to the same page,
which the private listener's Origin rule already limits to its own pages, and
`serve` approves it through Better Auth as the owner, with a session made for
that approval that expires with the code, ten minutes later. Better Auth's
`bearer` plugin carries that session; no session reaches a browser.

**There is one person, the owner.** The `user` table holds one row, created
when the server opens. A grant is a connector the owner approved, and an MCP
call needs its token's subject to be the owner. `epicenter connectors`, which
was `epicenter access`, lists connectors and revokes one; it no longer invites
or revokes people. Its files are `connectors.local.sqlite` and
`connectors.local.key`, which were `access.local.*`.

Grants made before this change are in the old `access.local.sqlite` under an
issuer that no longer exists, so they stop working, and each connector is
connected again once. Nothing migrates them; the old files can be deleted.

## Consequences

- Tailscale is required for people, on every device they use, and for Funnel
  on the computer running `serve`. A device without it, such as a borrowed
  laptop, cannot open the apps. iOS runs one VPN at a time.
- Anyone the tailnet admits can approve a connector, as anyone it admits can
  already use every app (ADR-0864). Sharing the computer through Tailscale
  shares that.
- A link that starts an attacker's authorization still lands on the approval
  page, as it did with passkeys; the page leads with the connector's host.
- Deleted: `@better-auth/passkey`, invites, `/.sign-in`, the session routes
  and redirects on the public listener, `prompt=login`, the `/.auth` base
  path, the people in `epicenter access`, and the rule that `public` and `publicPort` come
  together, which the `connectors` block makes structural.
- Added: the `bearer` plugin, and Better Auth's consent call from the private
  listener. Session tokens exist only in `serve`'s memory and the database,
  for ten minutes each.
- ADR-0871's open points about invites, sessions on the public hostname, and
  views on the public origin no longer apply.

## Considered alternatives

- **Keep passkeys for people without Tailscale.** About 700 internet-facing
  lines for a case no one has, and a product for that person would sign in at
  a hosted edge, not here.
- **Bundle a private network.** `serve` cannot give a phone a network without
  a client on the phone; that client is Tailscale's, or ours rebuilt.
- **Approve by Tailscale identity headers (ADR-0871's first version).** Trusts
  headers only Funnel strips. Here the boundary is the socket an approval
  arrives on.
- **Derive the tailnet address from the public host and `port`, or ask the
  `tailscale` command.** The first holds on the Studio by convention only; the
  second ties `serve` to Tailscale's command line. The field is one line.
- **Sign the session cookie by hand instead of the `bearer` plugin.** Needs
  `better-call` directly and its cookie format; the plugin is the documented
  route.
- **Keep old grants working.** A migration for one connector, which is
  connected again in a minute.
- **Replace Better Auth with an authorization server Epicenter owns.** With
  one owner and no sign-in, a connection could be one row Epicenter writes:
  opaque tokens stored as hashes, revoke as a delete, rotation as one
  conditional update. That would remove the placeholder owner, the approval
  sessions and `bearer`, the JWTs and `isGrantLive`, and the generation
  triggers written against Better Auth's private `verification` encoding,
  which make a Better Auth upgrade the weak boundary. Refused because
  ChatGPT's client metadata documents declare `private_key_jwt` with a
  `jwks_uri` (fetched 2026-11-12), so an owned server would also verify client
  assertions, fetch and check their keys, and refuse a replayed `jti`, which
  Better Auth's CIMD and OAuth provider already do. Claude's declares `none`.
  Revisit if both clients authenticate as public clients, or if a Better Auth
  upgrade breaks the triggers.
