# 0754. A capability takes what it needs as values and shows what it can do now as values

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Relates:** [ADR-0753](0753-an-app-declares-what-it-is-and-what-it-needs-the-platform-supplies-where-how-and-when.md) (an app declares what it needs), [ADR-0755](0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md) (which packages are capabilities), [ADR-0731](0731-every-app-signs-in-as-its-site.md) (`connectAccount()` takes no identity options), [ADR-0740](0740-every-credential-an-app-holds-lives-in-its-own-place.md) (where the person's provider keys live), [ADR-0746](0746-the-web-is-online-offline-needs-an-installed-app.md) (the online web).
- **Unbuilt:** `connectAccount()` with `account.current()` and `account.subscribe`; `openFolder(contract)`; `openAi({ account, local })` with `ai.models()`, `ai.hosted()`, `ai.local()`, `ai.custom()`, `ai.subscribe`, and `ai.complete`; the Svelte adapters `fromAccount` and `fromAi`; the browser recorder taking its folder as a value instead of importing `deviceFiles` from `@epicenter/folder/browser`.

## Context

Epicenter's packages reach each other directly. The browser recorder
imports `deviceFiles` from `@epicenter/folder/browser`
(`packages/recorder/src/browser.ts`), so building the recorder builds a
folder leaf with it. `@epicenter/ai` imports the `Account` type from
`@epicenter/auth`.

What a package can do on this platform, for this person, is spread across
constructors. `@epicenter/ai` opens hosted inference with
`openEpicenterInference`, a provider endpoint with `openEndpointInference`,
and the person's connections with `createAiConnections`; an app calls the
ones its platform and sign-in allow.

The auth package already has the shape the other packages need. The client
`createBrowserOAuth` returns (`packages/account/src/browser-oauth.ts`) reads
through `getState()` and notifies through `onStateChange(fn)`. `fromAuth`
(`packages/account/src/svelte/auth.svelte.ts`) wraps it for Svelte: a `state`
getter that subscribes through `createSubscriber` only while something reads
it. AGENTS.md's read-API rule asks for explicit read methods in ordinary
TypeScript and allows getters in Svelte adapters.

## Decision

**A capability takes what it needs as values and never imports another
capability.** It may import the type of a value it receives; it never
imports another capability's code. An app's `app.ts` composes them:

```ts
export const account = connectAccount();
export const folder = await openFolder(whispering);
export const ai = openAi({ account, local: localModels }); // localModels is null on the web
```

**What a capability can do now is a value, present or `null`.** `null`
means signed out, or not on this platform. No capability carries a separate
`supported` flag beside the value.

**The account is live, so a capability receives the account, never a
snapshot.** `account.current()` returns `Account | null` at each read.
`openAi({ account })` holds the account and reads it at use, so sign-in and
sign-out reach every capability without a reload. Only the online web
reloads on a change of account, because its data is the account's
([ADR-0746](0746-the-web-is-online-offline-needs-an-installed-app.md)).

**A core API reads through explicit methods and notifies through one
`subscribe` per capability; its Svelte adapter exposes getters.**

| | Core | Svelte adapter |
| --- | --- | --- |
| read | `ai.models()` | `fromAi(ai).models` |
| read | `account.current()` | `fromAccount(account).current` |
| change | `ai.subscribe(fn)`, which returns the unsubscribe | a read of the getter inside a tracking context |

`subscribe` fires on any change the capability's reads can show; the
listener reads again what it needs. The adapter follows `fromAuth`: a getter
per read method, subscribed only while read.

**AI shows each source of models as a value.**

```txt
ai.models()         every usable model, in default order local, hosted, custom, each tagged with its source
ai.hosted()         null when signed out; otherwise the account's plan and usage
ai.local()          null on the web; otherwise this computer's models, with download and remove
ai.custom()         the person's provider keys, to add and remove; always present
ai.subscribe(fn)    one notification for a change to any of the above
ai.complete(req)    sends the request through the chosen model's source
```

**A per-source handle exists only when it carries a reason or actions the
list cannot.** `hosted()` carries the plan and usage, `local()` carries
download and remove, and `custom()` carries the keys. A source with none of
these is a filter on `ai.models()` by its source tag.

## Consequences

- `app.ts` is the one file that knows which capabilities run together. A
  capability's tests construct it from plain values, without another
  capability's package.
- A settings screen shows a source when its handle is present. Why it is
  absent follows from the values: `account.current()` is `null`, or the
  platform passed `null`, as the web passes for `local`.
- A capability that depends on another's live state takes it as a parameter
  and subscribes to it, so its constructor grows one parameter per
  dependency and `app.ts` carries the wiring.
- The browser recorder's import of `deviceFiles` becomes a value it
  receives. `@epicenter/ai`'s import of the `Account` type stays.
- Today's names change with their packages: the auth client's `getState()`
  and `onStateChange` become `account.current()` and `account.subscribe`, and
  `fromAuth` becomes `fromAccount`
  ([ADR-0755](0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md)).

## Considered alternatives

- **Capabilities import each other, as the browser recorder imports
  `deviceFiles`.** Building one capability builds the other's platform
  leaf, and a test needs both packages.
- **Pass `account.current()` at construction.** The capability holds a
  snapshot, and sign-in needs a reload to reach it.
- **A `supported` flag beside each value.** Two values that can disagree,
  where `null` is one.
- **A handle per source whether or not it carries anything.** Three objects
  to check where a filter on `ai.models()` does the same.
- **Getters on the core API.** A read looks like field access in code where
  nothing tracks it; AGENTS.md keeps getters to Svelte adapters.
- **One subscription per field.** A listener per read, where one
  notification and a fresh read cover every field.
