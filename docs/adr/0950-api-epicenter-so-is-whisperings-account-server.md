# 0950. `api.epicenter.so` is Whispering's account server

- **Status:** Proposed
- **Date:** 2026-11-17
- **Relates:** [ADR-0894](0894-whispering-8-keeps-its-recordings-and-their-audio-in-its-own-data-directory-and-needs-no-epicenter.md) (Whispering keeps its recordings itself, which removes the hosted folder), [ADR-0899](0899-the-folder-sync-product-is-retired.md) (the folder sync product is retired), [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) (one OAuth authorization server), [ADR-0943](0943-epicenters-core-invariants.md) (what a simplification removes, and who accepts it).
- **Unbuilt:** all of it, in the change that builds ADR-0894.

## Context

The hosted API (`apps/api` and `packages/server`) grew to serve the folder
sync product and every app that signed in to it: Todos, Capture, Vocab,
Zhongwen, the Epicenter desktop app (`so.epicenter`), and the CLI
(`so.epicenter.cli`, by device grant). The folder sync product is retired
(ADR-0899), and Whispering 8 keeps its recordings on its own device
(ADR-0894). The apps Epicenter runs for a person live in their home, which
signs no one in. Whispering is the one product left that calls the hosted
API: for paid models. No account holds data in a hosted folder (the owner,
2026-11-17).

The API runs as a Cloudflare Worker and also as a Bun server
(`apps/api/server.ts`), and deploys on every push to `main`.

## Decision

**`api.epicenter.so` exists so a Whispering user can sign in and pay for
models. It keeps sign-in, the OAuth server, the two paid routes, Autumn
credits, and the account dashboard, and nothing else.**

| Keeps | Loses |
| --- | --- |
| Sign-in with Google, GitHub, Microsoft, Apple, and passkeys | The OAuth clients of Todos, Capture, Vocab, Zhongwen, the Epicenter desktop app, and the CLI |
| The OAuth server, for Whispering's desktop and browser builds | Device sign-in: `/device` and the device code grant |
| `/v1/chat/completions` and `/v1/audio/transcriptions`, in OpenAI's request shape, metered by Autumn credits | `/folders`, the `folders` audience and scopes, the R2 binding, and the `storage_bytes` meter |
| The account dashboard: the account, usage, and credits | `/api/session` |
| The Cloudflare Worker | The Bun server (`apps/api/server.ts`) |

- The consent screen goes if no remaining client needs it; Whispering is a
  first-party client.
- The hosted API knows nothing of a home. A home reaches no hosted route,
  and the hosted API reaches no home.
- Dropping the tables the removed routes used is a separate operation the
  owner approves; the change that removes the routes leaves production data
  alone.

## Consequences

- Whispering is the hosted API's one client, so a change to the API is
  judged by what Whispering needs.
- The apps in the repository are `apps/whispering`, `apps/api`, and
  `apps/landing`.
- **What this removes, and who accepts it** (ADR-0943):

  | Removed | Who loses what | Who takes on the work |
  | --- | --- | --- |
  | Other apps' OAuth clients | Nothing; those apps no longer sign in | None |
  | Device sign-in | A CLI or a home cannot sign in to the hosted API | Whoever designs a later hosted service for homes, which brings its own sign-in |
  | The Bun server | Running the API outside Cloudflare | The owner, who runs the Worker locally with Wrangler |
  | `/folders` and its storage | Nothing; no account holds data there | The owner, who approves deleting the empty tables |

- A later hosted service, such as shared Whispering text through Yjs or Git
  LFS storage for a home, is a new decision with its own record.

## Considered alternatives

- **Keep device sign-in for a later home service.** Code and a grant with no
  caller, kept for a service not yet designed.
- **Keep the Bun server for self-hosting.** A second runtime for the one
  deployment that runs.
- **Record this inside ADR-0894.** A reader looking for why device sign-in
  went would not look in a record about where Whispering keeps its
  recordings.
