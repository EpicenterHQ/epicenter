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
the opened folder context or session, installs providers during initialization,
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
Whispering's layout continues to acquire and release its richer session;
`WhisperingApp` provides that session to its pages. The naming convention
changes neither acquisition nor cleanup ownership.

## Consequences

Search results and component trees identify the product root without relying
on the directory name. Product names repeat in filenames, and a product rename
requires updating its root component name.

Existing product roots keep their state and behavior. A component needs no
additional wrapper merely to satisfy the naming convention. Folder contexts
retain the `context` prop; Whispering retains its `session` prop.

## Considered alternatives

- `App.svelte` is shorter, but search results across the monorepo lose the
  product name.
- `<Product>Shell` describes layout while hiding provider and product setup.
- `<Product>View` gives the root the same role name as one of its screens.
