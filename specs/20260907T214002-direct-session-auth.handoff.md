# Direct-session auth execution handoff

**Status:** Draft

Use the following as a cold-start task prompt. The canonical plan is
[direct-session auth](20260907T214002-direct-session-auth.md).

---

Replace Epicenter's first-party OAuth-provider/access-and-refresh-grant layer
with direct Better Auth session bearers. Preserve Google/GitHub social sign-in.
The clients are standalone browser SPAs, SPAs in the desktop host's WebViews,
and the hosted dashboard. All three use the same captured `Account` contract
and hosted session validator. Browser apps and the dashboard share a browser
composition; Bun holds the desktop credential and brokers traffic without
exposing the token to a WebView.

Read these first:

1. `docs/adr/0354-hosted-applications-authenticate-with-better-auth-session-bearers.md`
2. `specs/20260907T214002-direct-session-auth.md`
3. `packages/auth/README.md` and `packages/auth/src/auth-contract.ts`
4. `packages/server/src/auth/plugins.ts`, `packages/server/src/auth/base-config.ts`,
   and `packages/server/src/middleware/require-auth.ts`
5. `apps/epicenter/src/desktop-auth-authority.ts`,
   `packages/auth/src/desktop-broker-auth.ts`, and `apps/epicenter/src/server.ts`
6. `apps/api/ui/src/lib/platform/auth.ts` and `apps/api/ui/src/lib/billing/api.ts`

The user authorizes a complete break. Assume no users, nobody logged in, and
no old installation to support. Temporary compiler and runtime breakage is
acceptable. Do not build token conversion, old-format readers, dual validators,
flags, compatibility releases, staged rollouts, or a data migration for obsolete
OAuth rows. Replace the schema and fixtures for a fresh database. Remove the
old path before the replacement works if that clarifies the final ownership.
Prove the finished system; intermediate checkpoints need not stay green.

Inspect the checkout before editing. The Account and desktop-relay work is
committed in `dca1909f60`; `f272e2ae34` updates its documentation and ADR links.
Start from that implementation: `open(account)`, Account-keyed session children,
retirement-safe HTTP/sockets, and the credential-free WebView relay already
exist. Replace the credential machinery underneath that contract. Reconsider
internal wrappers freely; preserve the tested behavior. The deliverable
is a verified local implementation, not a production deployment or a reset of
an unknown database. Disposable test state can be recreated.

Every first-party app already gets the same resource access, and the JWT
resolver performs a database user lookup anyway. The separate OAuth grants do
not buy the per-app permission model that would justify keeping them. Better
Auth remains the session engine and the client of Google/GitHub. Removing
Epicenter's provider role preserves social login and its provider credentials.

Deleting OAuth registrations must preserve exact callback allowlisting, CORS,
and trusted-origin policy. A trusted app on an independently operated domain
can use the same session ceremony after explicit origin approval. This does
not grant arbitrary sites access or introduce limited third-party delegation.
External package distribution and proposed blob API changes are separate work.

Resolve the difficult evidence question early: securely issue independent
client sessions from hosted browser sign-in to a browser SPA and the Bun host.
The inspected Better Auth 1.6.23 bearer plugin accepts session tokens but does
not supply a complete native ceremony. Its one-time-token plugin returns an
existing session and does not by itself establish PKCE binding. Current
Electron integration docs demonstrate a stronger handoff; do not assume that
API works unchanged in Tauri. Prefer supported facilities or a small plugin.
Do not reconstruct OAuth grants under different names.

Independent client sessions must have independent revocation. Issuance from a
stale hosted login must not manufacture fresh permission to change login
methods. Preserve verified authentication age through all sensitive checks, or
require proven fresh authentication. A new row or successful SSO redirect alone
does not prove freshness. Never put session tokens in callback URLs or WebView
bootstraps. Prove PKCE, state, callback validation, atomic single-use redemption,
and stale/cancelled completion behavior.

Within a running auth authority, keep `Account` identity through renewal,
disconnection, and uninterrupted same-person reauthentication. Navigation or
host relaunch recreates the runtime and app session. Sign-out or replacement
permanently retires the old Account. A cancelled or older callback must not
overwrite a newer account choice; a current deliberate switch retires the
previous attachment before publishing the replacement.
Pending requests, streams, sockets, and failed desktop relaunches must not let
old work use the successor account. The dashboard uses a captured bearer with
no ambient-cookie fallback. Scope its query state to the attachment, including
sign-out followed by same-person sign-in; principal equality is insufficient.

Enabling `bearer()` changes what Better Auth `getSession` accepts. The current
account-deletion gate is named cookie-only but does not reject authorization
headers. Verify freshness hooks, hook ordering, and principal binding on real
routes. Retain provider/passkey browser ceremonies, local broker cookies,
origin checks, and self-host's static-token resolver. They do not require a
second hosted application credential model.

Choose session duration and renewal explicitly. Test renewal through actual
bearer resource traffic. Revocation does not close an admitted socket by itself;
establish a short authorization bound that survives idle traffic and Durable
Object hibernation. Inspect live store-sync code rather than historical rooms
documentation. Verify deployment session isolation after removing JWT audience
validation.

Carry forward the lifetime, broker, real loopback, and delayed blob-operation
regressions listed under the spec's current evidence. Adapt their credential
fixtures; do not discard account-isolation coverage with the OAuth code. The
baseline passed 282 targeted tests and affected typechecks, but packaged native
login remains unverified. Those results do not validate the new session path.

The first proof remains secure issuance of an independent client session.
Removing the OAuth grant lifecycle does not remove the need for a protected
handoff. If the required replacement grows into a bespoke auth server, explain
that evidence before spreading it across callers.

In Claude Code, `/codex:rescue` is an optional resource for a bounded problem,
such as reviewing the handoff protocol or reproducing a lifetime race. You
choose the implementation and review approach.

Work in dependency order from the spec. Use independent reviewers for the
handoff protocol and account-lifetime behavior if useful. Finish with targeted
tests, affected typechecks, browser/dashboard/native sign-in smoke evidence,
and a deletion sweep. Report any untested real provider or native path. The
desired artifact is one coherent hosted session path, its verification, and
documentation describing what works. No compatibility branch is part of it.
