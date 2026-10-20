# 0655. Product root components use the app name and App suffix

- **Status:** Accepted
- **Date:** 2026-10-21

## Context

The components inside the shared folder root performed the same entry role
under different names: `TodosView`, `CaptureApp`, `NotesView`, and `VocabShell`.
Whispering's `AppShell` provided its session and query client, guarded departure,
and rendered its routed pages. These names made product setup look like either
a screen or a layout wrapper.

## Decision

**Name a product's root component `<Product>App`.** The product root receives
the opened folder context, installs providers during initialization,
and composes product state and UI.

| Product | Component |
| --- | --- |
| Todos | `apps/todos/src/routes/local/TodosApp.svelte` |
| Capture | `apps/capture/src/lib/components/CaptureApp.svelte` |
| Honeycrisp | `apps/honeycrisp/src/routes/components/HoneycrispApp.svelte` |
| Vocab | `apps/vocab/src/routes/components/VocabApp.svelte` |
| Whispering | `apps/whispering/src/routes/components/WhisperingApp.svelte` |

**Reserve `Shell` for surrounding layout and `View` for a screen or
representation.** Examples of views include `WordsView` and `FileView`.
Specific tools within a larger application retain their purpose names,
such as Epicenter's `FolderEditor`.

`FolderApp` remains the shared folder lifecycle component. It invokes the
app-supplied opener, prepares its context, and closes it on departure.
Whispering uses the same shared root in its persistent layout. `WhisperingApp`
receives only the opened context, installs it, and owns recording, inference,
forms,
and view state across route changes. Its product constructor assembles platform
capabilities internally; the layout does not pass a workspace. It registers
workflow teardown as an app
action before `FolderApp` closes storage. Folder owns accepted file edits and
their persistence; the UI context connects it to queries and window behavior.

## Consequences

Search results and component trees identify the product root without relying
on the directory name. Product names repeat in filenames, and a product rename
requires updating its root component name.

Existing product roots keep their state and behavior. A component needs no
additional wrapper merely to satisfy the naming convention. Folder contexts
retain the `context` prop, including Whispering.

## Considered alternatives

- `App.svelte` is shorter, but search results across the monorepo lose the
  product name.
- `<Product>Shell` describes layout while hiding provider and product setup.
- `<Product>View` gives the root the same role name as one of its screens.
