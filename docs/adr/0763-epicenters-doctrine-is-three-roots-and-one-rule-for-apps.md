# 0763. Epicenter's doctrine is three roots and one rule for apps

- **Status:** Superseded
- **Date:** 2026-11-04
- **Superseded by:** [ADR-0899](0899-the-folder-sync-product-is-retired.md): the folder sync product is retired, and this record is its history.
- **Amends:** [ADR-0719](0719-every-change-to-the-data-model-is-checked-against-eight-principles.md) above its principles, without changing their text: the principles sit under the three roots and the rule for apps; [ADR-0762](0762-epicenter-is-made-of-standards-and-places.md) at its decision: its two halves become root 2 (programs meet in shared places) and root 3 (speak the standard).
- **Relates:** [ADR-0749](0749-epicenter-draws-its-boundaries-where-people-already-expect-them.md) and [ADR-0741](0741-epicenter-reconciles-only-states-it-made.md), which stay records and do not become roots.
- **Amended by:** [ADR-0787](0787-records-that-assumed-a-running-engine-or-a-build-time-choice-follow-0750-and-0781.md) at root 1's "A folder's path derives from the app's site": a folder is found by its `AGENTS.md`.
- **Amended by:** [ADR-0801](0801-records-from-0763-to-0800-agree-on-the-merge-rust-patching-marks-and-agents.md) at `settle` among the inventions, Whispering's seams, and agents under root 2: the key merge, no seams, and an agent's command is a person's tool.
- **Amended by:** [ADR-0813](0813-epicenter-is-your-folders-and-apps-are-lenses.md) at its rule for apps: an app is a lens on folders.
- **Amended by:** [ADR-0818](0818-an-app-is-a-view-a-window-and-its-capabilities-and-everything-is-repairable-by-hand.md) at its rule for apps: an app is a view, a window, and its capabilities; everything the platform does can be done by hand.

## Context

By 2026-11-04 `docs/vision.md` opened with twelve numbered items, each
citing a record: the rule for apps (ADR-0753), an app is its site
(ADR-0722), items and documents (ADR-0742), the visible root (ADR-0752),
sync is like save (ADR-0750), signing in per app (ADR-0731), the library
(ADR-0751), the online web (ADR-0746), reconciling what Epicenter made
(ADR-0741), boundaries where people expect them (ADR-0749), adapting to what
you have (ADR-0758), and standards and places (ADR-0762).
[ADR-0719](0719-every-change-to-the-data-model-is-checked-against-eight-principles.md)'s
eight principles sat under them.

Every item was true, and nothing said which items explained the others.
Several restated one another: ADR-0758 and the first half of ADR-0762 both
say Epicenter uses a standard where one exists, and ADR-0750 and the second
half of ADR-0762 both say programs meet in the folder. Each new record could
add a thirteenth item.

## Decision

**Epicenter's doctrine is three roots and one rule for apps.** A root is an
idea without which Epicenter would have made different decisions; each root
below names the decisions it changed.

### Root 1: your things are files in a place you can see

Derived records: [ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md)
(names from the site),
[ADR-0730](0730-everything-not-derived-from-an-apps-site-is-one-of-five-stored-kinds.md)
(five stored kinds),
[ADR-0742](0742-items-are-what-you-keep-documents-are-whats-live.md) (items
and documents),
[ADR-0746](0746-the-web-is-online-offline-needs-an-installed-app.md) (the
web is online),
[ADR-0752](0752-an-apps-folder-sits-under-the-platforms-visible-root-of-app-folders.md)
(the visible root).

What it changed:

- Tabs kept saved tabs in a document synced through the account
  ([ADR-0724](0724-a-browser-extension-keeps-its-data-in-a-document.md)). A
  saved tab is now an item, `tabs/<id>.md`, in a folder (ADR-0742,
  [ADR-0743](0743-tabs-keeps-saved-tabs-as-items-in-a-collection.md)).
- A phone app keeps its items in its container, which the Files app shows as
  "On My iPhone", and never in AppData (ADR-0752).
- Offline use with sync is an installed app's folder, not a copy in the
  browser's storage (ADR-0746).
- A folder's path derives from the app's site, so no program stores a
  location or keeps a registry of folders (ADR-0722, ADR-0730).

### Root 2: programs meet in shared places, never by calling each other

Derived records:
[ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md)
(sync is like save),
[ADR-0751](0751-every-native-app-carries-one-sync-core.md) (one core in
every native app),
[ADR-0757](0757-every-model-is-an-endpoint-every-model-file-is-a-cache.md)
(the model cache),
[ADR-0759](0759-an-apps-native-shell-is-generated-on-every-build.md) (the
generated shell).

| Shared place | Who meets there |
| --- | --- |
| an app's folder: its files, `.git`, and `.git/epicenter-sync.lock` | every program that syncs it |
| the Hugging Face cache | every app and tool that runs a local model |
| a capability's `package.json` | the shell generator, which reads the plugin and permissions each capability declares |

What it changed:

- "Syncing needs Epicenter" and the Epicenter app's `sync --watch`
  ([ADR-0713](0713-one-epicenter-engine-per-machine-syncs-every-apps-folder.md))
  became a round any program runs under the folder's lock (ADR-0750).
- An app stopped asking the `epicenter` engine to sync its folder and links
  the sync core itself (ADR-0751).
- Apps share model files through the Hugging Face cache instead of a model
  server (ADR-0757).
- A capability's native plugin and permissions reach the shell by the
  generator reading them, not by editing a committed shell (ADR-0759).

**One exception is named:
[ADR-0745](0745-a-browser-extension-writes-through-the-local-epicenter-engine.md).**
A browser extension calls the local `epicenter` engine over Chrome native
messaging, because a browser sandbox cannot reach a folder. Another
exception states the same kind of reason: a program that cannot reach the
place.

### Root 3: speak the standard; invent only what none covers

Derived records: [ADR-0727](0727-json-schema-is-the-field-language.md)
(JSON Schema), [ADR-0731](0731-every-app-signs-in-as-its-site.md) (OAuth
per app),
[ADR-0733](0733-your-own-git-in-an-epicenter-folder-is-plain-git.md) (plain
Git), [ADR-0757](0757-every-model-is-an-endpoint-every-model-file-is-a-cache.md)
(endpoints as `fetch`, the OpenAI-compatible vocabulary),
[ADR-0758](0758-epicenter-adapts-to-what-you-already-have-and-owns-only-what-nothing-else-can.md)
(adapt, don't own),
[ADR-0762](0762-epicenter-is-made-of-standards-and-places.md) (standards
and places).

What it changed:

- Field builders that compiled one declaration into four outputs
  ([ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md)) became
  JSON Schema that each reader interprets (ADR-0727).
- One sign-in per machine in the keychain item `so.epicenter.session`
  ([ADR-0720](0720-you-sign-in-a-machine-not-an-app.md)) became standard
  OAuth, one grant per app (ADR-0731).
- Epicenter stopped writing a credential helper, a merge driver path, and
  Git LFS hooks into Git configuration (ADR-0733).
- `openEpicenterInference` and `openEndpointInference` became endpoints of
  the shape `{ id, fetch, models() }`, each speaking the OpenAI-compatible
  vocabulary through a Fetch API function (ADR-0757).

**Epicenter invents three things:** names derived from a site (ADR-0722),
the merge rule `settle`
([ADR-0734](0734-every-file-other-than-a-note-is-kept-whole-in-git-lfs.md)),
and the sync core (ADR-0751).

### The rule for apps

**An app declares what it is and what it needs; the platform supplies
where, how and when**
([ADR-0753](0753-an-app-declares-what-it-is-and-what-it-needs-the-platform-supplies-where-how-and-when.md)).
[ADR-0754](0754-a-capability-takes-what-it-needs-as-values-and-shows-what-it-can-do-now-as-values.md),
[ADR-0755](0755-epicenters-packages-are-capabilities-formats-framework-layers-and-programs.md),
[ADR-0756](0756-an-apps-native-shell-is-linked-from-its-capabilities.md),
and ADR-0759 apply it. The roots say what the system is; the rule says what
an app's own code may contain. Under it, app code calls no sync function,
and each of Whispering's four `#platform/*` seams becomes a capability's
implementation or names the app-owned feature it serves.

### What stays a record

**Boundaries where people already expect them (ADR-0749) and refusing with
the command (ADR-0741) stay accepted records, not roots.** Each governs as
written. A recurring argument becomes a root only by the test above, so the
doctrine does not grow to fit the records already written.

**ADR-0719's principles sit under the roots and the rule.** Their text is
unchanged and they still govern changes to the data model.

## Consequences

- A new decision names the root it follows, or says why it needs none. A
  decision that departs from a root names the root and why it cannot serve,
  as ADR-0745 does for a browser sandbox.
- An explanation that drove no decision is not added, as a root or as an
  item in `docs/vision.md`.
- `docs/vision.md` states the three roots and the rule and links the records
  under each. The detail lives in the records.
- A fourth root is added only with the decisions it changed.
- Some accepted records, such as ADR-0749 and ADR-0741, sit under no root. A
  reader reaches them from the records that cite them, not from the
  doctrine.

## Considered alternatives

- **Keep the twelve items.** Nothing marks which item explains the others,
  and each new record can add one.
- **Make ADR-0749 and ADR-0741 roots.** Both recur in arguments, and
  promoting each recurring argument fits the doctrine to the records already
  written.
- **One root, "adapt to what you already have" (ADR-0758).** It covers
  root 3 and says nothing about how programs reach each other: an Epicenter
  daemon that speaks only standards satisfies it.
