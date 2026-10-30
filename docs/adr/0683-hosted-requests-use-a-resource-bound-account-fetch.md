# 0683. Hosted requests use a resource-bound Account fetch

- **Status:** Accepted
- **Date:** 2026-10-22
- **Relates:** [OAuth resource tokens](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) keeps desktop tokens out of WebViews; [Hosted inference](0634-hosted-inference-is-independent-of-repository-sync.md) makes inference independent of repository access.
- **Implemented:** Whispering's hosted transcription and text requests use an API-bound `Account.fetch` in both builds. The browser has an explicit account connection and OAuth callback; Settings reads the `fromAuth` Svelte facade. Its client does not navigate on a renewal timer because a recording must survive while the page is open. The desktop window has a narrow account command permission and opens Epicenter Settings at Account for sign-in. The CLI checks the grant generation; the host cancels retired native sends. The desktop grant still belongs to the CLI.

## Context

`@epicenter/auth` already gives an `Account` an authenticated `fetch`.
Browser OAuth attaches the token for the resource selected when the Account
opens. `@epicenter/ai` uses that fetch for hosted inference. At this decision's
start, the desktop adapter had the same public method, but no production page
constructed it and no window could call `account_send`. Whispering sent hosted requests
through the separate `ai_send` target. The CLI owns the desktop grant, refreshes
its rotating token under a file lock, and sends both kinds of request.

Those paths did not compose. Inference uses `/v1/*`, while desktop
`account_send` allowed only `/api/*` and profile userinfo. A desktop
Account is bound to either the API or Git audience; a Git-bound Account cannot
authorize inference. The desktop adapter also checks Account retirement only
before and after sending, without stopping the request or its response stream.
More seriously, it captures the signed-in person but does not pass the grant's
identity to the sender. If Settings replaces Alice's grant with Bob's before a
page refreshes, Alice's retained Account could send using Bob's token.

## Decision

**An Account's `fetch` is the app-facing transport for requests authorized by
that Account's one resource.** It remains in `@epicenter/auth`. A browser
Account uses its browser OAuth resource and browser fetch. A desktop Account
uses the host's account sender. Hosted inference requires an API-bound Account;
Git operations require a Git-bound Account. Neither the page nor a URL silently
switches an Account to another audience. `getProfile` is the existing narrow
API-userinfo operation, including for a Git-bound Account. A caller that can
identify a wrong resource must refuse it before dispatch; the base `Account`
type need not acquire a resource field, since the dashboard's cookie-session
Account has no OAuth resource.

**The desktop host authorizes an account request before the credential owner
sends it.** The host checks the calling window's permission, audience, and raw
method and path. Whispering is granted only the API audience and the exact
`POST /v1/audio/transcriptions`, `POST /v1/chat/completions`, and
`GET /auth/oauth2/userinfo` operations. The CLI resolves the deployment
destination and checks its origin and permitted account path before choosing a
token; its path rule is broader than the host's window-specific allowlist.
A command grant by itself does not authorize every audience or API path. The
sender removes page-supplied authorization and cookies, attaches its own
token, sends no ambient cookies, and refuses redirects. The page's checks
are not the authority. A future Git-bound desktop caller needs its own host
permission and path policy.

**Each desktop request is bound to the grant from which its Account was
opened.** Sign-in creates an opaque random grant generation, stored with the
desktop grant and unchanged by refresh. Status exposes that nonsecret
generation; the Account captures it, and each send carries it as an expected
generation. The credential owner compares it with the grant on the same read
that supplies a cached token, and again after acquiring the refresh lock if a
refresh is needed. A mismatch refuses the send before token selection and
causes the page to retire and re-read its Account. Existing grants without a
generation must be upgraded under the grant lock before opening an Account;
an unsuccessful upgrade refuses Account creation. A timestamp, account ID, or
separate preflight status read cannot replace this check. A grant whose person
is still unknown cannot open an Account until identity is recovered; it is
reported distinctly from a signed-out grant.

**Account and caller retirement cancel the desktop send and its response
body.** The desktop adapter combines the caller's abort signal with the
Account's lifetime; page teardown also stops its request. The bridge asks the
host to end the CLI request and the returned stream while allowing an
in-progress token refresh to save its rotated token before process exit. The
host remembers the latest 128 cancellations that arrive before their sends
register in one window; an older cancellation can be evicted if that bound is
exceeded. A request already processed by the server cannot be undone.

**The CLI remains the only owner of the `so.epicenter` desktop grant in this
stage.** Desktop account requests still start a CLI child. Whispering's hosted
branch captures an API-bound Account and passes its `fetch` into its existing
transcription and transformation request functions. The Account supplies the
base URL and sign-in identity for that branch, rather than a second status
read. The host's hosted `ai_send` target is removed after its final caller moves;
the CLI send bridge remains for account and bring-your-own-provider requests.
The grant-generation check and Whispering migration ship together so a pending
Whispering request cannot borrow a replacement grant.

**Whispering's app UI uses one Svelte auth facade in both builds.** A build-time
auth leaf keeps the vanilla client private and exposes `fromAuth(client)`.
Settings reads reactive `auth.state`, calls the same `auth.refresh()` method
on focus in either build, and uses `onStateChange` only to trigger an imperative
connection reread. Browser refresh reconciles saved OAuth state; desktop refresh
reads the shell's grant status. The browser callback completes sign-in without
opening Whispering's folder. A
browser connection explicitly selects the Epicenter account or a custom
endpoint; selecting the account retains the previous custom endpoint for a
later switch back. Both hosted routes capture the current Account before
sending, and the browser route remains subject to the API's CORS policy.
Browser Whispering opts out of timer-driven OAuth renewal so an active
recording is not ended by an unattended navigation. A refused token prompts
an explicit sign-in from Settings.

When Epicenter's shell stops using the CLI for account calls, native code must
take exclusive ownership of its desktop grant as one migration: sign-in,
status, sign-out, keychain entry, serialized refresh, account sending, and
hosted inference sending. The CLI's desktop-grant path then retires. The
terminal's separate device grant and Git credential helper remain CLI work.
Native code cannot merely read the CLI's rotating secret or expose it through
app-owned secrets. A standalone shell that needs hosted calls without a CLI
uses a grant registered for that shell, not Epicenter's desktop grant. A shared
native auth implementation is warranted when multiple shells need it; neither
a shared grant nor a native plugin is required by this stage.

## Consequences

- `Account.fetch` composes with hosted inference without adding a general
  `@epicenter/fetch` package. Whispering retains its multipart and JSON request
  construction and its error mapping; it does not have to adopt the OpenAI SDK
  inference client.
- The desktop host keeps account tokens out of the page. Browser calls remain
  subject to browser CORS; native sending does not make browser CORS disappear.
- Grant replacement cannot silently change the person who authorizes an
  already-open Account. A focused test must replace the grant between Account
  acquisition and send, then confirm the old Account dispatches no request.
- The first stage still pays for CLI children and its request wire protocol.
  Moving only account HTTP into Rust would add an OAuth owner without removing
  the CLI needed for other desktop operations.
- App-owned provider keys and user-chosen endpoints remain separate from this
  account grant. Moving the current shared Whispering connection credentials
  to app-owned secrets needs its own ownership and migration decision.

## Considered alternatives

- **A general `@epicenter/fetch` or direct page use of Tauri HTTP fetch.**
  Neither owns the account grant, its audience, its lifetime, or the decision
  to attach a token. Reading the grant through a generic secrets handle would
  expose a host credential to the WebView.
- **Move only account sending to Rust now.** Login, refresh, hosted Whispering
  sends, and sign-out would still use the CLI's rotating grant. Two owners
  could spend the same refresh token; moving all of them now adds a native OAuth
  implementation before a desktop `Account.fetch` caller exists.
- **Choose an audience from each requested URL.** A URL is not a grant. For
  example, `GET /api/repos` is at the API origin but needs the Git audience;
  `/v1/*` needs the API audience. Automatic switching would widen a page's
  authority beyond the Account it opened.
