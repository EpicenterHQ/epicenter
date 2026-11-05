# Vision

Every app keeps your things as files in its own folder, under the root your
device shows you; one sync core moves those folders through your account; and
Epicenter, where it exists, is the library over them.

Read this page first. It states Epicenter's doctrine, three roots and one
rule for apps
([ADR-0763](adr/0763-epicenters-doctrine-is-three-roots-and-one-rule-for-apps.md)),
and links the records that hold the detail. Most of it is not built yet; each
record's `Unbuilt` line says what is missing.
[Positioning](positioning.md) owns what Epicenter claims today.

## Your things are files in a place you can see

What you keep is items: one Markdown file each, fields in front matter and
then a body, in the app's folder. That folder sits under the root your device
shows you, `~/Epicenter` on a computer and the app's container on a phone,
and its name derives from the app's site, so no program stores where it is.
Records: [ADR-0722](adr/0722-an-apps-names-derive-from-its-sites-host.md),
[ADR-0730](adr/0730-everything-not-derived-from-an-apps-site-is-one-of-five-stored-kinds.md),
[ADR-0742](adr/0742-items-are-what-you-keep-documents-are-whats-live.md),
[ADR-0746](adr/0746-the-web-is-online-offline-needs-an-installed-app.md),
[ADR-0752](adr/0752-an-apps-folder-sits-under-the-platforms-visible-root-of-app-folders.md).

## Programs meet in shared places, never by calling each other

Any program can sync a folder, and none owns it: programs take turns through
the folder's lock. Each native app carries the same sync core, so it needs
nothing else running to sync. Apps share model files through the Hugging Face
cache, not a server. The one exception is a browser extension, which calls
Epicenter on the same computer because a browser cannot reach a folder.
Records:
[ADR-0750](adr/0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md),
[ADR-0751](adr/0751-every-native-app-carries-one-sync-core.md),
[ADR-0757](adr/0757-every-model-is-an-endpoint-every-model-file-is-a-cache.md),
[ADR-0759](adr/0759-an-apps-native-shell-is-generated-on-every-build.md);
the exception,
[ADR-0745](adr/0745-a-browser-extension-writes-through-the-local-epicenter-engine.md).

## Speak the standard; invent only what none covers

History is plain Git, sign-in is OAuth with one grant per app, fields are
JSON Schema, and a model is any endpoint that speaks the OpenAI-compatible
vocabulary. A tool that speaks the standard works with Epicenter unchanged.
Epicenter invents three things: names derived from a site, merging a note's
front matter by key (Git merges its body, ADR-0795), and the sync core.
Records:
[ADR-0727](adr/0727-json-schema-is-the-field-language.md),
[ADR-0731](adr/0731-every-app-signs-in-as-its-site.md),
[ADR-0733](adr/0733-your-own-git-in-an-epicenter-folder-is-plain-git.md),
[ADR-0757](adr/0757-every-model-is-an-endpoint-every-model-file-is-a-cache.md),
[ADR-0758](adr/0758-epicenter-adapts-to-what-you-already-have-and-owns-only-what-nothing-else-can.md),
[ADR-0762](adr/0762-epicenter-is-made-of-standards-and-places.md).

## An app declares what it is and what it needs; the platform supplies where, how and when

An app is its contract, its site, and the capabilities it composes in
`app.ts`. The platform picks the folder's root, the implementation for
desktop, phone, or web, and the moments sync runs, so an app's code names no
path, no platform, and no sync moment. Records:
[ADR-0753](adr/0753-an-app-declares-what-it-is-and-what-it-needs-the-platform-supplies-where-how-and-when.md),
[ADR-0754](adr/0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md),
[ADR-0755](adr/0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md),
[ADR-0756](adr/0756-an-apps-native-shell-is-linked-from-its-capabilities.md),
[ADR-0759](adr/0759-an-apps-native-shell-is-generated-on-every-build.md),
[ADR-0765](adr/0765-choose-by-value-not-by-name-every-capability-has-the-same-shape.md).

## What this means for you

- **On a Mac,** Whispering's recordings are files in `~/Epicenter/whispering`,
  which Finder shows. Whispering syncs its folder when it opens, a few seconds
  after you save, when you come back to it, and when you press Sync. The
  Epicenter app, if you install it, is the library: every folder by team,
  each collection as a table you filter with `select * from todos where …`
  and edit in place, and what needs a look across all of them (ADR-0790).
- **On an iPhone,** no app exists yet. The first will keep its folder where
  the Files app shows it, "On My iPhone > Whispering", and carry the same sync
  core.
- **In a browser,** every web app is online: you sign in and it works in your
  team's repository (ADR-0786). Working offline needs an installed app. A
  browser extension saves through Epicenter on the same computer.
- **For an agent,** an item is a file it edits directly. Each folder's
  `AGENTS.md` names the app's contract and tells the agent to run
  `epicenter sync <dir>` before it starts and after it finishes.

## What Epicenter refuses

- A registry of apps or folders, or a stored location for any folder
  ([ADR-0721](adr/0721-an-apps-folder-is-derived-never-stored.md)).
- Items in AppData, where you cannot see them
  ([ADR-0752](adr/0752-an-apps-folder-sits-under-the-platforms-visible-root-of-app-folders.md)).
- One program that syncs for the others, and a file watcher, timer, or
  background service to sync
  ([ADR-0750](adr/0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md)).
- A model server or model directory of its own
  ([ADR-0757](adr/0757-every-model-is-an-endpoint-every-model-file-is-a-cache.md)).
- A format, store, or protocol of its own where a tool you have already
  serves
  ([ADR-0758](adr/0758-epicenter-adapts-to-what-you-already-have-and-owns-only-what-nothing-else-can.md)).
- Merging two unrelated histories, or adopting a folder whose Git history it
  did not make
  ([ADR-0735](adr/0735-sync-gives-files-a-history-it-never-merges-two.md),
  [ADR-0761](adr/0761-sync-never-merges-two-unrelated-histories.md)).
- A log or outbox of operations for sync
  ([ADR-0744](adr/0744-sync-diffs-state-because-agents-edit-state.md)).
- A committed native shell, or a package that wraps an app's capabilities
  ([ADR-0756](adr/0756-an-apps-native-shell-is-linked-from-its-capabilities.md),
  [ADR-0759](adr/0759-an-apps-native-shell-is-generated-on-every-build.md)).
