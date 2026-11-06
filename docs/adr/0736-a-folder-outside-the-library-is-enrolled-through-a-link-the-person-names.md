# 0736. A folder outside the library is enrolled through a link the person names

- **Status:** Accepted (2026-11-04)
- **Date:** 2026-11-04
- **Amends:** [ADR-0715](0715-the-epicenter-app-browses-every-folder-and-document-a-person-has.md) at "'Add folder…' runs `epicenter link`, which puts a link to a folder from anywhere inside the root": the link's name is one the person confirms and no app could claim; [ADR-0721](0721-an-apps-folder-is-derived-never-stored.md) at its example `ln -s whispering ~/Epicenter/voice`: a name without a dot belongs to Epicenter's apps, so a person's own link takes a name with a space.
- **Relates:** [ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md) (names without a dot belong to Epicenter's apps, names with a dot to owners), [ADR-0729](0729-a-link-is-followed-only-at-or-above-a-root.md) (a link is followed at or above a root), [ADR-0718](0718-epicenters-machinery-on-a-machine-lives-in-a-hidden-home-every-program-reads.md) (the scan of the root).
- **Amended by:** [ADR-0825](0825-the-epicenter-folder-contains-its-folders.md) at a folder outside joining through a link: the folder moves into the Epicenter folder, and a link outside reaches it.

## Context

[ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md) divides the top
of `~/Epicenter`: a name without a dot is one of Epicenter's apps
(`whispering`), and a name with a dot is an owner's folder
(`bradenwong.com`). It says a person's link "should not take a name without
a dot that Epicenter could later give one of its apps".

[ADR-0715](0715-the-epicenter-app-browses-every-folder-and-document-a-person-has.md)
has "Add folder…" run `epicenter link`, which puts a link inside the root to
a folder kept anywhere, such as an Obsidian vault in `~/Documents/Vault`. It
does not say what the link is called. A link named `vault` is a name
Epicenter could give an app later, and when that app runs it would open the
vault as its own folder ([ADR-0726](0726-an-apps-path-is-its-claim.md)).
[ADR-0721](0721-an-apps-folder-is-derived-never-stored.md)'s example,
`ln -s whispering ~/Epicenter/voice`, has the same problem.

## Decision

**A folder outside `~/Epicenter` is enrolled through a link at
`~/Epicenter/<name>`, and the person names it.**

```txt
~/Epicenter/
  whispering/                          an Epicenter app: no dot
  bradenwong.com/                      an owner: a dot
  Obsidian Vault -> ~/Documents/Vault  a person's own folder: a space
```

- **The name can never be one an app could claim.** An app's name is a host
  label or a host, which has no space. A person's own folder takes a name
  with a space.
- **Epicenter suggests a name and the person confirms it.** The suggestion
  is the folder's own name when it has a space (`Obsidian Vault`), and
  otherwise the name prefixed with "My " (`My notes` for `~/notes`).
- **`epicenter init <path> --name "<name>"` refuses a name without a
  space,** with an error saying that names without a space belong to apps
  and owners (`isPersonalFolderName`, `packages/definition/src/site/app-names.ts`).
- **Removing the folder from Epicenter removes the link and leaves the
  files.**

A person's own short link to an app's folder follows the same rule
(`~/Epicenter/My voice -> whispering`).

## Consequences

- No app can later find a person's folder at its own path.
- Epicenter's scan tells three kinds of top-level name apart by their
  characters: no dot, a dot, a space.
- A person cannot name a linked folder `notes` or `vault`; shells need quotes
  for the space.
- A folder linked before this rule under a name without a space keeps working
  until an app with that name is installed.

## Considered alternatives

- **The folder's own name, unchanged.** `vault` or `notes` could become an
  app's name later.
- **A fixed subfolder such as `~/Epicenter/Folders/`.** A name without a dot
  that an app could claim, and one more level for every folder a person adds.
- **A prefix character such as `_vault` or `@vault`.** Readable to a program,
  and a convention a person must learn; a space is how people already name
  folders.
