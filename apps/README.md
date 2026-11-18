# Apps

The apps in this folder are outside apps: each works without an Epicenter
([ADR-0901](../docs/adr/0901-an-app-is-inside-an-epicenter-or-outside-it.md),
[ADR-0902](../docs/adr/0902-this-repositorys-outside-apps-stay-in-apps.md)).

| App | What it is |
| --- | --- |
| [Whispering](whispering/README.md) | A voice recorder that runs on your device, in a browser tab or as a desktop app. |
| [API](api/README.md) | The server behind it: accounts, paid models, and hosted-only billing. |
| [Landing](landing) | The website at epicenter.so. |

Personal apps such as Capture and Tasks live in the owner's Epicenter. One
private Git repository holds each app's `apps/<name>/code/` and sibling
`data/`. This repository includes [Writing](../examples/writing/) as an
example you can copy into a home's `apps/writing/code/`, as the
[Writing README](../examples/writing/README.md) shows.
The `epicenter-app` skill says how to make and change one.

Honeycrisp, Local Books, the PostHog proxy, and the composition guide that
described the retired product's apps are at the tag `before-0891-layout`.
