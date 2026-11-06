# 0818. An app is a view, a window, and its capabilities, and everything is repairable by hand

- **Status:** Accepted (2026-11-06)
- **Date:** 2026-11-06
- **Amends:** [ADR-0763](0763-epicenters-doctrine-is-three-roots-and-one-rule-for-apps.md) at its rule for apps: an app is a view, a window, and its capabilities, and the doctrine adds that everything the platform does can be done by hand.
- **Relates:** [ADR-0812](0812-an-apps-schema-is-a-view-that-must-fit-a-folders-contract.md) (a view), [ADR-0813](0813-epicenter-is-your-folders-and-apps-are-lenses.md) (folders and lenses), [ADR-0814](0814-one-window-shows-one-folder.md) (one window, one folder), [ADR-0815](0815-the-platform-gives-a-window-its-folder-and-every-app-the-same-home.md) (`openFolder(view)` and the home), [ADR-0817](0817-the-cli-exposes-every-platform-operation-and-an-app-inherits-everything-about-folders.md) (what an app inherits), [ADR-0797](0797-front-matter-is-a-strict-grammar-and-anything-else-is-body.md) (the front-matter grammar), [ADR-0804](0804-a-computer-keeps-a-plain-folder-and-every-surface-syncs-with-one-typescript-function.md) (the manifest).
- **Unbuilt:** all of it: `@epicenter/app` with `defineView`, `openFolder`, the capabilities, and the platform's pieces; the platform making `~/Epicenter` and an app's first folder; every app rebuilt to this shape, Whispering first.

## Context

Apps grew from different starts: Whispering kept its data and later learned a
folder; others began from a folder. Since ADR-0813 a folder comes first and an
app is a lens, the platform owns everything about folders (ADR-0817), and a
window shows one folder (ADR-0814), so what is left to an app is small enough
to state once for all of them. Every part of the platform rests on plain files:
a contract file, front matter of `key: <JSON>`, and a manifest that is a cache.

## Decision

**An app is three parts.**

```ts
// view.ts: what it understands in a folder, compiled to the contract
export const view = defineView({
  recordings: { path: 'recordings/{name}.md', fields: { title: text(), recordedAt: instant(), duration: seconds() } },
  audio: { path: 'recordings/{name}.{ext}' }, // a collection of files: a pattern with no fields
  transformations: { path: 'transformations/{name}.md', fields: { title: text() } },
});

// app.ts: its folder and its capabilities
export const folder = openFolder(view);
export const recorder = openRecorder();
export const ai = openAi({ account });
export const shortcut = openShortcut();
```

and a window, its interface over that one folder, which places the platform's
pieces (history, share, the marks) where it wants them.

**Every contract follows five rules:**

1. A collection is a path pattern, `{name}` its stem: a pattern ending in `.md`
   holds notes with fields, and any other holds files. An item's name is its
   file name.
2. Fields are short values (`key: <JSON>`); prose, and anything people read, is
   the body.
3. Files that share a directory and a name are one item, so a recording's audio
   beside its note belongs to it with nothing declaring so. Field helpers such
   as `text()` are a shorthand for plain JSON Schema, which a hand-written
   `epicenter.json` uses.
4. What belongs to one computer (a microphone, a model, a key, a policy) is the
   app's settings, never the folder's.
5. A view only adds; it never assumes it is alone in a folder.

**The lifecycle is the platform's.** On a computer with no `~/Epicenter` the
platform makes it. An app with no folder that fits makes one (its title the
app's suggestion, its `epicenter.json` the view's collections, beside
`AGENTS.md`) and opens it, so a person uses the app at once; with one that fits,
or one it remembers, it opens that; with several, it shows the home. Signing in
syncs it at its moments; share, history, and opening another folder in another
window are there from the start.

**Everything is repairable by hand.** Whatever the platform does, a person or a
script can do with plain file operations: make a directory in `~/Epicenter`,
write `epicenter.json`, write items with `key: <JSON>` front matter, and an app
opens the result as if it had made it. `@epicenter/app` is convenience, never a
requirement. No database hides beside the files, and `.epicenter/` is a cache
whose loss costs only the next sync's speed.

## Consequences

- An app holds no storage, sync, sharing, history, or first-run code.
- A person's first use of an app needs no questions.
- If Epicenter disappeared, every folder would still be plain files any program
  reads and writes.
