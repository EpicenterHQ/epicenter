# Apps

The apps in this folder are outside apps: each works without an Epicenter
([ADR-0901](../docs/adr/0901-an-app-is-inside-an-epicenter-or-outside-it.md),
[ADR-0902](../docs/adr/0902-this-repositorys-outside-apps-stay-in-apps.md)).

| App | What it is |
| --- | --- |
| [Whispering](whispering/README.md) | A voice recorder that runs on your device, in a browser tab or as a desktop app. |
| [Landing](landing) | The website at epicenter.so. |

Personal apps such as Capture and Tasks live in the owner's home, one
private Git repository: each is a function in `apps/<name>/` that the home's
`epicenter.ts` composes, and their records live in the home's `data/`
([ADR-0971](../docs/adr/0971-an-epicenter-is-one-program-composed-in-its-root-epicenter-ts.md)).
This repository ships no apps of that kind, examples included
([ADR-0969](../docs/adr/0969-the-repository-ships-no-apps.md)).
[`@epicenter/app`'s README](../packages/app/README.md) says how to make one.

Honeycrisp, Local Books, the PostHog proxy, and the composition guide that
described the retired product's apps are at the tag `before-0891-layout`.
