# 0683. Hosted requests use a resource-bound Account fetch

- **Status:** Proposed
- **Date:** 2026-10-22
- **Relates:** [OAuth resource tokens](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) keeps desktop tokens out of WebViews; [Hosted inference](0634-hosted-inference-is-independent-of-repository-sync.md) makes inference independent of repository access.
- **Unbuilt:** A production desktop `Account.fetch` caller, its window permission and grant-generation check, `/v1/*` account sending, request and response cancellation, and Whispering's hosted-route migration. The desktop grant still belongs to the CLI.

## Context

`@epicenter/auth` already gives an `Account` an authenticated `fetch`.
Browser OAuth attaches the token for the resource selected when the Account
opens. `@epicenter/ai` uses that fetch for hosted inference. The desktop
adapter has the same public method, but no production page constructs it and
no window can call `account_send`. Whispering instead sends hosted requests
through the separate `ai_send` target. The CLI owns the desktop grant, refreshes
its rotating token under a file lock, and sends both kinds of request.

Those paths do not yet compose. Inference uses `/v1/*`, while desktop
`account_send` currently allows only `/api/*` and profile userinfo. A desktop
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
sends it.** The host checks the calling window's permission for the bound
resource and the normalized destination's origin, method, and path. The API
resource permits the hosted `/v1/*` operations needed by that window; the Git
resource permits its Git operations, including `GET /api/repos` at the API
origin. Profile reads permit only `GET /auth/oauth2/userinfo` with the API
resource. A command grant by itself does not authorize every audience or API
path. The sender removes page-supplied authorization and cookies, attaches its
own token, sends no ambient cookies, and refuses redirects. The host and CLI
both validate the destination; the page's checks are not the authority.

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
Account's lifetime; page teardown also stops its request. The bridge ends the
CLI request and the returned stream while allowing an in-progress token
refresh to save its rotated token before process exit. A request already
processed by the server cannot be undone.

**The CLI remains the only owner of the `so.epicenter` desktop grant in this
stage.** Desktop account requests still start a CLI child. Whispering's hosted
branch will capture an API-bound Account and pass its `fetch` into its existing
transcription and transformation request functions. The Account supplies the
base URL and sign-in identity for that branch, rather than a second status
read. The hosted `ai_send` target can be removed after its final caller moves;
the CLI send bridge remains for account and bring-your-own-provider requests.
The grant-generation check and Whispering migration ship together so a pending
Whispering request cannot borrow a replacement grant.

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
