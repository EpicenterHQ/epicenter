# 0749. Epicenter draws its boundaries where people already expect them

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amended by:** [ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md) at the "when sync runs" row: people expect sync where they expect save, so it runs when an app opens, after a save, on return to its window, and on request.
- **Relates:** [ADR-0719](0719-every-change-to-the-data-model-is-checked-against-eight-principles.md) (the principles this explains), [ADR-0741](0741-epicenter-reconciles-only-states-it-made.md) (a refusal names the command that resolves it).

## Context

Several decisions made on 2026-11-04 rest on the same argument: the
boundary goes where people already believe it is. The web works online and
an installed app works offline. Files sit in a folder a person can open in
Finder. A browser extension pairs with its desktop app. Each record made the
argument for itself, and none stated it as a rule a later design can cite
or be checked against.

## Decision

**When a boundary must exist, Epicenter puts it where people's existing
intuitions already place it, and the screen says it in their words.**

| Boundary | What people already believe | Record |
| --- | --- | --- |
| the web and an installed app | a website needs the internet; an installed app works offline | [ADR-0746](0746-the-web-is-online-offline-needs-an-installed-app.md) |
| where data lives | your files are in a folder you can see in Finder | [ADR-0721](0721-an-apps-folder-is-derived-never-stored.md), [ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md) |
| access to the account | an app asks once to use your account, as signing in with Google or Apple does | [ADR-0731](0731-every-app-signs-in-as-its-site.md), [ADR-0732](0732-a-grant-reaches-what-the-person-chooses-at-consent.md) |
| a browser extension | an extension pairs with its desktop app, as Zotero Connector and 1Password do | [ADR-0745](0745-a-browser-extension-writes-through-the-local-epicenter-engine.md) |
| when sync runs | quitting an app stops what it does; Epicenter syncs while it runs | [ADR-0328](0328-epicenter-runs-when-you-log-in-and-pause-is-the-only-control-it-offers.md) |
| backup | a copy of a folder is a copy of your data | [ADR-0450](0450-current-files-own-portable-document-data.md) |

## Consequences

- A design that needs a person to learn a new model, such as replicas,
  authorities, or a sync state per item, states the existing model it
  departs from and why that one does not serve.
- A screen explains a limit in the person's own terms, as "On this browser" and
  "Not synced" do ([ADR-0719](0719-every-change-to-the-data-model-is-checked-against-eight-principles.md)). When the limit is a state
  Epicenter did not make, the screen also names the command that fixes it
  ([ADR-0741](0741-epicenter-reconciles-only-states-it-made.md)).
- Some boundaries cost what people already accept elsewhere: a Mac with
  Epicenter quit does not sync, and a phone browser does not work offline.

## Considered alternatives

- **Teach Epicenter's own model on screen.** Every person would learn terms
  such as authority and replica before trusting where their data is.
- **Draw each boundary where the implementation is simplest.** The person
  meets a limit with no intuition that predicts it.
