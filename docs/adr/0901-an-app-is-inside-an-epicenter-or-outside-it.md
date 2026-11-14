# 0901. An app is inside an Epicenter or outside it

- **Status:** Proposed
- **Date:** 2026-11-14
- **Amends:** [ADR-0889](0889-an-app-runs-on-epicenter-a-program-works-with-it-and-they-meet-at-the-apps-contract.md) at "Records, code, and directory names say `program`": both kinds are apps, an inside app and an outside app, and a program is one kind of outside app. Its contract rules stand.
- **Amends:** [ADR-0891](0891-this-repository-holds-the-runtime-and-programs-and-every-starter-is-a-repository-of-its-own.md) at "nothing under `programs/` is an app": nothing under `programs/` is an inside app. Its layout stands.
- **Relates:** [ADR-0896](0896-each-collection-has-one-writer-of-record-and-epicenter-never-reconciles-two-writable-copies.md) (where a collection's truth is), [ADR-0898](0898-what-arrives-is-cached-what-the-person-decides-is-kept-and-an-item-moves-by-transfer.md) (pull, move, and apply), [ADR-0899](0899-the-folder-sync-product-is-retired.md) (the earlier product's words are retired with it).
- **Unbuilt:** nothing; this decides words. `docs/vision.md` states them under "The pieces".

## Context

ADR-0889 gave two nouns: an `app` is a folder in an Epicenter, and a `program`
is software that runs on its own, such as Whispering. It said people read
"app" for both, and that records, code, and directory names say `program`.
`docs/vision.md` then added `service` for software someone else runs, such as
Gmail.

That left three top-level nouns, and the one people use for all three, "app",
was reserved for the least familiar. A person calls Whispering and Gmail
apps. Explaining Epicenter meant first taking that word away from them.

## Decision

**Every app is inside an Epicenter or outside it.**

| Noun | What it is | Example |
| --- | --- | --- |
| inside app | a folder in an Epicenter, whose `epicenter.ts` runs on the home | `~/Epicenter/apps/vocab/` |
| outside app | any software that works without an Epicenter | Whispering, Gmail, Beeper, Todoist |
| program | an outside app that runs on your device | Whispering |
| service | an outside app that runs on someone else's servers and holds the truth of its own data | Gmail |
| source | where a pull copies from: a service, or a program's folder | Gmail's API, `~/Whispering` |

- **The test is one question:** does it work without an Epicenter? If it
  does, it is an outside app.
- **Bare "app" in records and code means an inside app,** as before.
  `defineApp` and `apps/` keep their names. The qualifier is added wherever
  both kinds are in one sentence or section.
- **Data crosses only through an inside app's actions.** Mail brings Gmail
  in; Gmail does nothing.
- **A product can have both halves.** Whispering is an outside app, and
  "Whispering's inside app" is the `whispering` folder in an Epicenter.
- **`program` and `service` stay,** as the two kinds of outside app, so
  `programs/` in this repository still names what it holds.

## Considered alternatives

- **`app`, `program`, and `service` as three top-level nouns** (ADR-0889 and
  the vision before this). No sentence needs a qualifier, but the common word
  names the uncommon thing.
- **`app` inside and `source` outside.** Rejected: "source" already means
  where a pull copies from, and an outside app that nothing pulls from is not
  a source.

## Consequences

- A sentence that names both kinds carries a qualifier; one that names only
  inside apps does not.
- Whether the `whispering` folder keeps that name is open.
- Records before this one keep their wording.
