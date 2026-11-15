# 0912. Shared app code comes from the app we maintain

- **Status:** Proposed
- **Date:** 2026-11-15
- **Amends:** [ADR-0891](0891-this-repository-holds-the-runtime-and-programs-and-every-starter-is-a-repository-of-its-own.md) at "Every starter is a repository of its own": shared app code can be an exported folder in a public repository.
- **Unbuilt:** publishing the exported Writing code and CLI downloads.

## Context

A developer needs one useful app before adapting its files. Treating Writing
as a template gave it a separate maintenance path from the apps we use. Export
already produces shareable code from a maintained app, and `new --from` takes
that code into another person's Epicenter. Onboarding can use those operations.

## Decision

Writing is a normal app maintained in an Epicenter. Commit its code, then export
it into the monorepo's `examples/writing/` or an app collection. Export owns that
generated directory; Git and handwritten publication files stay outside it.
Maintain code in the app and re-export it, rather than editing generated files.

Recipients use `new <name> --from <repository>#<folder>`. They receive a new app
with copied code, empty records, and a source commit in `code/SOURCE.md`.
The CLI carries no apps and has no named-template mechanism. Shared apps declare
their minimum CLI version in `engines.epicenter`, like every other app.

The copy uses a commit. Local paths and non-bare file URLs are compared with
that exact commit, including staged and untracked code. The command reports
copyable files left out, while excluding records, local files, dependencies,
builds, and provenance. It never commits the source automatically. Reporting
differences from the copied commit also stays true when the source commits
another change during the copy.

## Consequences

Each recipient owns their copy. Taking a later change means comparing the
recorded source with incoming code and adapting the existing app deliberately,
preserving its records and local edits. `new` creates apps; it is not an updater.

A repository maintained directly as a project is also valid. It is maintained
source, so export must not be used to replace it. This choice does not change
the app format or how recipients take a copy.

## Considered alternatives

- Bundle Writing and expose `--template writing`: offline creation, but a
  special app inside the runtime and another distribution path to maintain.
- Keep a hand-maintained Writing template beside the runtime: adds a second
  maintenance workflow instead of exercising app export.
- Copy a local working tree automatically: changes the meaning of `--from`
  based on its transport and loses the committed base used to review updates.
- Commit a refreshed export automatically: combines source selection with a
  history mutation that the person must review.
- Build a registry: adds naming, discovery, and publication machinery while a
  Git URL already identifies source to copy.
