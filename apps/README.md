# Apps

The apps in this folder are outside apps: each works without an Epicenter.

| App | What it is |
| --- | --- |
| [Whispering](whispering/README.md) | A voice recorder that runs on your device, in a browser tab or as a desktop app. |
| [Landing](landing) | The website at epicenter.so. |

Personal apps such as Capture and Tasks live in the owner's home, one
private Git repository: each is a function in `apps/<name>/` that the home's
`epicenter.ts` composes, and their records live in the home's `data/`
([the home's rules](../packages/app/README.md#the-home)).
This repository ships no apps of that kind, examples included.
[`@epicenter/app`'s README](../packages/app/README.md) says how to make one.

Honeycrisp, Local Books, the PostHog proxy, and the composition guide that
described the retired product's apps are at the tag `before-0891-layout`.
