# 0955. `new` makes a blank app, and taking an app is copying its folder

- **Status:** Proposed
- **Date:** 2026-11-17
- **Supersedes:** [ADR-0929](0929-new-copies-an-apps-code-from-a-folder-in-git-or-a-folder-on-github.md): `new --from` no longer exists.
- **Relates:** [ADR-0904](0904-copying-is-the-only-way-to-take-an-apps-code.md) (copying is the only way to take an app's code; this record says who copies), [ADR-0911](0911-export-copies-an-apps-committed-code-into-a-refreshable-directory.md) (export writes the folder people copy)

## Context

`epicenter new <name> --from <source>` copied one committed app folder into a
home. It took a path or `owner/repo/folder#ref`, cloned the source, found the
app's folder, refused uncommitted local code, filtered paths, checked files
out with LFS forced on, refused gitlinks, patched LFS attributes, listed the
apps in a folder that held several, renamed the copy's package, removed its
`bun.lock` and `@epicenter/app`, and wrote `SOURCE.md`. That was about 400
lines, and its own design questions (copy the commit or the disk? refuse or
include uncommitted edits?) existed only because it put Git between a person
and a folder copy. No one outside this repository took an app with it.

An app is a folder of plain files. The operating system copies folders, and
GitHub serves any folder of any ref as part of a tarball.

## Decision

`epicenter new <name>` makes only a blank app: `apps/<name>/code/` with
`.gitignore`, a `package.json` named `<name>` that lists no packages, and
`epicenter.ts`, beside an empty `data/`. It prints
`Run: cd <home> && bun install && bun run build`.

Taking an existing app is copying its `code/` folder into
`apps/<name>/code/`:

```sh
# From GitHub, at the top of the home:
mkdir -p apps/writing/code
curl -L https://github.com/EpicenterHQ/epicenter/archive/main.tar.gz | tar -xz -C apps/writing/code --strip-components=3 epicenter-main/examples/writing

# From this computer, or a clone from any other host:
mkdir -p apps/journal
cp -R ~/Code/shared-apps/apps/notes/code apps/journal/code
```

When the new name differs from the source's, the person sets `"name"` in the
copy's `package.json`, since Bun refuses two workspace packages with one name
and a package with none. Then `bun install && bun run build`.

## Consequences

- What is copied is what is on disk or in the downloaded ref. There is no
  uncommitted-code refusal, filter, or LFS handling; the person's tools
  decide.
- Nothing records where a copy came from. A person who wants that writes it
  down, or commits the copy with a message that says so.
- A forgotten rename fails loudly at `bun install`.
- A copy without `data/` works: an app's records folder is made when it is
  first written.
- `export` stays, and still uses `code-copy.ts`; it is the publishing side of
  the same copy.
- A sharing command may return when people other than the owner take apps,
  shaped by what they trip on.
