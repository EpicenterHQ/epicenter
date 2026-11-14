# Apps

The apps in this folder are outside apps: each works without an Epicenter
([ADR-0901](../docs/adr/0901-an-app-is-inside-an-epicenter-or-outside-it.md),
[ADR-0902](../docs/adr/0902-this-repositorys-outside-apps-stay-in-apps.md)).

| App | What it is |
| --- | --- |
| [Whispering](whispering/README.md) | A voice recorder that runs on your device, in a browser tab or as a desktop app. |
| [API](api/README.md) | The server behind it: accounts, paid models, and hosted-only billing. |
| [Landing](landing) | The website at epicenter.so. |

Inside apps (Capture, Reading, Tasks, Vocab) are not in this repository. Each
is a repository of its own in its author's `~/Epicenter/apps`, taken with
`epicenter new <app> --from <git url>`
([ADR-0877](../docs/adr/0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md)).
The `epicenter-app` skill says how to make and change one.

Honeycrisp, Local Books, the PostHog proxy, and the composition guide that
described the retired product's apps are at the tag `before-0891-layout`.
