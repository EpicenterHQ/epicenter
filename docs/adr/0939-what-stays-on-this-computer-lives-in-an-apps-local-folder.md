# 0939. What stays on this computer lives in an app's `local/` folder

- **Status:** Proposed
- **Date:** 2026-11-17
- **Amends:** [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) on how a file is marked as staying here: by its place, not its name. Its rule that such a file never leaves its computer stands. [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md) on an app's layout: `local/` sits beside `code/` and `data/`.
- **Relates:** [ADR-0938](0938-an-action-says-whether-agents-are-offered-it.md) (a secret is ordinary input the first time), [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (where an action writes).
- **Unbuilt:** removing the old names. `isLocalPath` still matches `*.local` and `*.local.*` for `collection.ts`, `path.ts`, `field.ts` and the checkpoint's refusal, and the root still ignores them, until Mail, Messages and Flights have moved their 14 such files from `data/` to `local/`.

## Context

ADR-0870 said a file stays on this computer when a part of its path matches
`*.local` or `*.local.*`. A name can sit anywhere, so every place that
handles a path had to ask about it: file modes, temporary files, the
checkpoint's refusal, path templates, references between records, generated
actions, refusals that must not quote a value, and copied code.

The one thing a name can do that a place cannot is mark a file that sits
beside committed files of the same kind. The home has 16 local files: 4
credentials, 7 caches, and state and lock files. None sits beside a
committed sibling of the same collection.

## Decision

**An app is `code/`, `data/` and `local/`. What is in `local/` stays on this
computer.**

- `local/` holds plain files the app reads and writes through `folder`: a
  token at `local/google.md`, a cache at `local/mail.sqlite`. It holds no
  records: a collection's path is under `data/`.
- An action writes under `data/` or `local/` and nowhere else.
- A new file under `local/` is readable by its owner alone, and so is a new
  directory there.
- The root ignores `/apps/*/local/`. A checkpoint refuses to commit or push
  a path under it.
- A write replaces a file by renaming a temporary file over it. The
  temporary file is made under `local/`, so nothing under `data/` needs a
  name that Git must ignore.

**The old names are refused until they are gone.** The checkpoint keeps
refusing a path that matches `*.local` or `*.local.*`, and the root keeps
ignoring those names, until every such file in the home has moved to
`local/`. The refusal is the only thing between a hand-run `git add` and a
pushed token, and the home still holds tokens named the old way.

## Consequences

- "Is this local" is a prefix test in one place. The path template rule,
  the reference rule, the "offers no actions" rule and the redaction of
  values in refusals go with local collections.
- Mail's `data/google.local.md` and Messages' `data/beeper.local.md` become
  `local/google.md` and `local/beeper.md`, read by the code that used them.
  Each app moves its files when it moves to the new data declaration.
- Moving a file is not a rename Git sees, since neither name is tracked.
  A second computer recreates its `local/` as it recreated its `.local`
  files.
- A home made before this needs `/apps/*/local/` added to its `.gitignore`
  before it runs this version. Nothing in the CLI edits an existing ignore
  file, so until the line is there a checkpoint refuses the first file an
  app writes under `local/`, which is the safe way to fail.
- `isLocalPath` stays exported until the last app has moved, for the old
  collection code and the checkpoint's refusal.

## Considered alternatives

- **Keep the name.** It works, and it is why ten places ask about it.
- **Ask Git whether a path is ignored.** The app package has no Git, and a
  write would start a process to learn its own file mode.
- **Keep such files outside the repository.** The strongest guarantee, and
  it needs an id for the home and a second place for tests to clean up,
  which ADR-0870 removed.
- **The operating system's keychain.** A second store beside the folder,
  which does not stop a program running as the same user (ADR-0870).
