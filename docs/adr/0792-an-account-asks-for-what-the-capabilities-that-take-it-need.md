# 0792. An account asks for what the capabilities that take it need

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0781](0781-apps-branch-on-what-a-capability-offers-and-one-build-serves-every-surface.md) at "An app asks for an account for what it uses, and a place says whether it uses one": every capability that takes the account says what it needs, and the app lists nothing.
- **Relates:** [ADR-0754](0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md) (a capability takes what it needs as values), [ADR-0732](0732-a-grant-reaches-what-the-person-chooses-at-consent.md) and [ADR-0770](0770-teams-own-repositories-and-sharing-is-membership.md) (consent and the grant), [ADR-0785](0785-a-desktop-app-signs-in-to-sync-its-own-folder.md) (sync needs sign-in).
- **Unbuilt:** a Tauri window's sign-in asking for the needs its capabilities declared: the shell's sign-in asks for its own grant.

## Context

Sign-in asks the server for what an app will use: the app's repository in a
team, the AI gateway, the person's profile. Consent shows it, and the grant
is narrowed to it. A list of uses passed when the account is made repeats
what `app.ts` already says when it hands the account to `home` and to the
AI capability; an app that forgets an entry signs in without it, and its
requests fail later.

## Decision

**Each capability that takes the account says what it needs when it is
made**, and sign-in asks for all of them.

```ts
// the shape; each package names its own opener
export const account = openAccount({ site: APPS.TODOS.url });
export const folder = openFolder(todos, home({ site: APPS.TODOS.url, account })); // needs the repository
export const ai = openAi({ account });                                            // needs the AI gateway
```

`app.ts` makes every capability synchronously when it loads, before anyone
can sign in, so the account knows every need before its first sign-in. An
app that hands the account to nothing never shows sign-in.

## Consequences

- An app cannot ask for less than it uses, and asks for nothing it does not
  use.
- Consent names exactly what the app's capabilities reach.
- A version of an app that adds a capability needing more asks the person to
  consent again at its next sign-in.

## Considered alternatives

- **A list of uses when the account is made.** Visible in one line, but a
  second statement of `app.ts` that can disagree with it.
