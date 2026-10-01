# 0209. Epicenter is the raw view beside its applications, not a shell above them

- **Status:** Accepted
- **Date:** 2026-08-05
- **Amended by:** [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md). Proposed amendment: [ADR-0449](0449-epicenter-connects-independent-applications-through-personal-data.md) revises separate windows for hosted personal tools.
  Withdrawn: that the raw view can see an application's live rows. A host owns
  no application data, so `openInspection` over the host replica shows nothing
  of an application on the new store. The raw view itself, and every application
  still on the superseded stack, are unchanged.
- **Built, then deleted.** The raw view was a host module behind `/api/home/inspect` with a Data pane over it. It read the replica the host owned, and [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) withdrew that replica; [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md) made the break, and both the module and the pane are gone. The DECISION here stands: Epicenter is an application beside the others rather than a shell above them. What no longer exists is a way for it to read anybody else's rows, because an application on the store writes to its own client-owned store; a raw view has to become a replica of the authority it wants to read, and nobody has designed that.
- **Amends:** [ADR-0189](0189-home-launches-applications-into-their-own-windows-and-stays-open-behind-them.md), withdrawing "Home stays open behind them", Home-as-shell, and the refusal of a fourth pane, which was a refusal of a fourth *launcher-shaped* pane and cannot survive a record whose whole point is that Epicenter has a job of its own. Its per-application windows, its one launchable list, its one launch verb, and its refusal of an installation UI all survive. [ADR-0152](0152-epicenter-home-is-a-shell-above-workspaces.md), withdrawing the word its title turns on: Home is not above the workspaces, it is beside them. Everything that record decided about ownership stands.
- **Relates:** [ADR-0162](0162-epicenter-home-owns-relational-inspection-applications-receive-no-sql.md) (owns the inspection surface this finally gives a face), [ADR-0207](0207-rows-render-continuously-to-markdown-and-frontmatter-is-the-only-way-back.md) and [ADR-0208](0208-every-app-folder-is-markdown-beside-one-queryable-database.md) (the same data through files and SQL, which is what made an application a view), [ADR-0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md) (one origin), [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md), [ADR-0180](0180-epicenter-has-one-host-owned-active-local-transcription-model.md), [ADR-0190](0190-a-build-declares-which-epicenter-owns-its-data-not-which-window-it-runs-in.md)

## Context

ADR-0189 decided Home launches each application into its own window and stays
open behind it, as the shell. Living with that named a real cost: windows
accumulate, and Home becomes a window whose only job is to have launched
something.

A design pass answered that with one window and a switcher. Implementing it hit
a wall that the record had not priced. In Tauri a window label is not only a
place, it is the unit native authority is granted to. Every file in
`src-tauri/capabilities/` selects by label, a capability naming a window is
enabled for every webview inside it, and a capability added at runtime cannot be
removed. One window is one label is the **union** of Home's launch and
model-administration verbs, Whispering's keystroke injection, and the
trusted-app surface, held by whatever happens to be showing. The second of those
contradicts ADR-0180 outright, which grants model administration to Home and
nowhere else.

There is a way through: one window holding one webview per surface, with
capabilities selecting `webviews` instead of `windows`. It costs Tauri's
`unstable` feature, which this build does not enable.

Taking that route would have been solving the wrong problem. The complaint was
window management, on a machine that already has a launcher, a switcher, and a
window manager, all of which people already know how to use. Nothing was
weighed against doing none of it.

Meanwhile ADR-0207 and ADR-0208 changed what an application *is*. A note now
exists as a row, as a markdown file, and as a column in a queryable database,
none of which require Honeycrisp to be running. The data stopped living inside
the application. What is left of an application is the crafted way of looking at
it.

## Decision

**Epicenter is an application beside the others. It shows the data raw, the
applications are the crafted views, and the operating system is the launcher.**

### The OS launches and switches

Applications keep their own windows (ADR-0189). Command-Tab, Spotlight, Mission
Control, and window snapping are the switcher, and none of them are ours to
build.

Epicenter still holds the launch verb, because its windows are not separately
visible to the OS. That is a mechanism, not a hierarchy: an application that
launches other applications is still an application.

### Epicenter is not required

Close Epicenter and Honeycrisp keeps running. Nothing is behind anything. This
is already true of the process; what changes is that it is now the intended
posture rather than an accident, and Home stops being described as a shell.

### What Epicenter shows is the data raw

A sidebar of namespaces, and picking one is the mode:

```txt
NAMESPACES          SELECT * FROM notes WHERE title LIKE 'Tues%'
· honeycrisp        ─────────────────────────────────────────────
  home              id      title             tags
  whispering        01jq…   Tuesday standup   work
  ─────────
  Everything raw
```

Picking a namespace is `selectLens`: real tables, one column per declared field,
present rows only, and `SELECT * FROM notes` works verbatim. "Everything raw" is
`clearLens`: `_epicenter_rows`, the honest storage shape, JSON and tombstones
included. Both are ADR-0162's, and this record adds no query capability to them.

It is a fourth pane, `Data`, beside Apps, Chat, and Settings. Named for what a
person is looking for rather than for the vocabulary: "records" would be a second
word for a row, and "views" is now what the applications are.

**Grouping by namespace is not a view option, it is the mode.** A table name is
unqualified only inside one interpretation, and two applications may both
declare `notes`, so the friendly tables cannot exist ungrouped. The sidebar is
that invariant with a face on it.

### There is no pretty view across applications

Across namespaces you get `_epicenter_rows` and `json_extract`, and that is the
whole answer. Wanting one is reasonable; it costs a global type vocabulary above
Lenses, which is a larger thing than the problem.

### Applications are the crafted views

Honeycrisp is the editor, folders, and rich text. Whispering is recording and
playback. Epicenter is where you go when something is wrong, or when you want to
see across applications. It is not the daily driver, and it should not grow
toward being one.

A chat that can reach every application belongs here rather than in any one of
them, and is deferred.

## Consequences

- **The capability model is untouched.** Windows stay, so labels stay, so
  `home`, `whispering`, `app-*`, and `recording-overlay` keep meaning what they
  mean. ADR-0180 is not reopened, and the `unstable` Tauri feature is not taken.
- **Epicenter is not the product.** It is the substrate plus a browser over it,
  and the products are the applications on top. That is a different pitch from
  "super app" and should be said out loud rather than discovered by a user who
  opened Epicenter expecting somewhere to live.
- **`openInspection` finally has a caller.** It has existed since ADR-0162 with
  no surface reaching it. The raw view is that surface.
- The inspection surface is an HTTP route on the loopback host, because
  `openInspection` is Bun-owned and the applications share that origin
  (ADR-0118). ADR-0162 already accounts for this: on one trusted origin,
  "applications receive no SQL" is an API and product boundary rather than a
  sandbox. Do not describe the route as one.
- **Markdown in Spotlight is a side effect, not a path.** `~/Epicenter` is in the
  home directory, so the operating system indexes those files whether or not
  anyone designed it. Useful when it happens; never the navigation model, and
  never a reason to index rows into Spotlight deliberately.
- **ADR-0152's title is now wrong**, and the rule against editing an accepted
  decision means it stays wrong. The `Amended by` link is where a reader learns
  Home is not above anything.
- **What this forecloses:** one window, an in-app application switcher, a
  command palette over rows, Core Spotlight or any deliberate indexing of rows
  into an OS search index, a friendly SQL view spanning two namespaces, a
  writable inspection surface, and Home as a backdrop anything runs in front of.

## Considered alternatives

- **One window, and launching switches it.** Carried far enough to be written up
  and then refused on contact with the capability model, above. Even repaired
  with webviews it answers a question the operating system already answers, and
  it costs an unstable dependency in the desktop host to do it.
- **One window of many webviews, capabilities scoped per webview.** The correct
  repair if one window were the goal. Rejected with the goal, not on its own
  merits; reopen it only if something other than window management ever needs
  two applications inside one frame.
- **A command palette over every row, in Home.** Designed, then deleted. It is a
  worse Spotlight, over data Spotlight already indexes, reachable only once you
  are already inside Epicenter. The thing it was for is `Cmd-Space`.
- **Indexing rows into Spotlight through Core Spotlight** so a result opens in
  the application rather than a text editor. Genuinely possible and genuinely
  tempting. Rejected because Spotlight's job is opening applications, because it
  would be a third derived copy of every row living in an index we cannot
  deterministically rebuild, and because for the rows markdown serves well,
  landing in your editor is the point rather than a failure.
- **Making each application a real OS bundle** so Spotlight lists them. Rejected
  for cost: signing, updating, and an install story per application, to replace
  a list Epicenter already has.
- **Organizing the folder by data rather than by application.** Considered and
  refused for a good reason: `<namespace>/<table>/<row>` is the address
  (ADR-0206), and the namespace is what stops two applications both owning
  `notes`. An address space and a navigation surface are allowed different
  shapes, and this record changes only the second.
- **Folding the raw view into the Apps pane**, so the same sidebar lists
  launchable applications above browsable namespaces. Attractive, and refused
  because the two lists are not the same list: Whispering is launchable and
  declares no Lens this host binds, and `so.epicenter.home` is a namespace with
  no application to open. One sidebar would have to show that asymmetry or hide
  it, and both are worse than two panes.
- **Replacing the Apps pane with the raw view**, on the grounds that the OS is
  the launcher now. Rejected: Epicenter's windows are not separately visible to
  the OS, so the launchable list is still the only way to open anything.
