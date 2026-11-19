# 0053. The Epicenter bearer is an audience-scoped credential: `auth.fetch` attaches it only to the origin it signed into

- **Status:** Accepted
- **Date:** 2026-06-22
- **Relates:** [ADR-0054](0054-an-inference-backend-is-the-metered-gateway-or-a-custom-server.md) (the configurable backend this unlocks), [ADR-0035](0035-durable-storage-is-one-per-person-coordination-box.md) (cross-origin sync carries the bearer as a WebSocket subprotocol, not through this fetch), ADR-0050 (the inference wire whose base URL becomes user-chosen)

## Context

`auth.fetch` (the auth-owned credential boundary in `packages/auth`) attaches `Authorization: Bearer <access token>` to every request it makes, against any URL, and follows redirects with the header still attached. That was harmless while every caller targeted the Epicenter API. The configurable inference backend ([ADR-0054](0054-an-inference-backend-is-the-metered-gateway-or-a-custom-server.md)) ends that assumption: the moment a chat app can point its engine at a `localhost` Ollama or a third-party gateway, handing it `auth.fetch` ships the Epicenter access token to a box that is not Epicenter. The WHATWG rule that strips a developer-set `Authorization` on a cross-origin redirect would catch the redirect case, but it is absent in Tauri's reqwest-backed fetch and was version-gated in Chromium, so the runtime cannot be trusted to enforce it. A credential that attaches itself to any audience is the defect; the inference leak is only its first symptom.

## Decision

The Epicenter bearer is scoped to its audience by construction. `auth.fetch` attaches the bearer only when the request targets the origin the client signed into (its `baseURL` origin), and sends every other request with no Epicenter credential. Auth-bearing requests are issued with `redirect: 'manual'`, so a cross-origin redirect can never carry the header onward.

- The origin check lives at the single place the credential is attached (`fetchWithAuth`), not at each call site. Every consumer of `auth.fetch` in the repo becomes leak-proof, not just the inference path.
- This makes the leak structurally impossible, which retires the need for a typed "this fetch is safe for this URL" invariant on the inference seam. The backend resolver ([ADR-0054](0054-an-inference-backend-is-the-metered-gateway-or-a-custom-server.md)) pairs a fetch with a URL for clarity, not for safety.

## Consequences

- A whole class of guard is deleted before it is written. There is no branded "resolved backend" type and no phantom-type ceremony on the inference path; the one origin check is the guard, and it sits on the credential where the risk actually lives.
- Misuse fails closed. Passing `auth.fetch` to a custom backend by mistake (a copy-paste, a future "test connection" probe) sends no token; the request arrives unauthenticated rather than leaking a live bearer.
- The bearer never rides a redirect off-origin. An Epicenter endpoint that 3xx-redirects within its own origin still works; a cross-origin redirect is returned to the caller instead of being followed with credentials.
- A load-bearing test asserts the bearer is attached only to the signed-in origin and withheld from every other host, including across a redirect.
- Trade-off: any code that relied on `auth.fetch` reaching a non-Epicenter origin with the bearer would break. We verified no such caller exists. The bearer is for the Epicenter API alone, and cross-origin sync carries it as a WebSocket subprotocol ([ADR-0035](0035-durable-storage-is-one-per-person-coordination-box.md)), not through this fetch.

## Considered alternatives

- **Guard only at the inference resolver.** Rejected: it defends one consumer and leaves the footgun armed for the next caller that reaches for the authed fetch. The leak is a property of the credential, so the fix belongs on the credential.
- **A branded resolved-backend type the engine requires.** Rejected: a TypeScript brand certifies the resolver's output shape but cannot stop `auth.fetch`, which is structurally a plain fetch, from flowing into the custom branch. It guards the output end of the pipe while the leak enters at the input end. Ceremony, not protection.
- **Rely on the browser's WHATWG cross-origin `Authorization` strip.** Rejected: it is absent in reqwest (Tauri) and was version-gated in Chromium, so it is not a guarantee a local-first product spanning browser, extension, and desktop can lean on.
