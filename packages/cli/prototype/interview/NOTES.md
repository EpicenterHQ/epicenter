# Interview files prototype

This experiment asks whether keeping an upload and editing its notes needs more
than a directory binding and a Markdown editor. The directory is open: the
declaration names understood documents, while other files remain ordinary files.

Run from the repository root:

```sh
bun packages/cli/examples/interview.prototype.ts
```

Add `--keep` to retain the printed scratch directory, or `--interactive` to pause
between scenes and inspect it. The default removes its scratch files afterward.
The command uses a disposable Epicenter and runtime beside it. It never uses the
person's apps or initializes a Git repository.

The module is deliberately outside the production exports:

```ts
import { defineDirectory, markdown } from './packages/app/src/directory.prototype.js';

const interviews = defineDirectory({
  path: 'data/interviews/{id}',
  files: { notes: markdown('notes.md') },
});

const interview = interviews.at({ id: 'lee' });
await interview.keep(recording);
await interview.notes.create('Lee joined in 2018.\n');
await interview.notes.edit({ old: 'in 2018', new: 'in 2019' });
```

Selection only computes locations. `keep` streams the upload into a temporary
file, then publishes it with an exclusive hard link. The kept file has its own
inode and survives cleanup of the run's input. It preserves the original safe
basename, including its extension. Existing destinations and declared document
names are refused, including case-equivalent names. There is no primary-recording
role, MIME-to-extension inference, suffix allocation, or attachment manifest.

`create` makes new Markdown and refuses an existing destination. Both creation
operations can establish missing directories. `edit` requires an existing file
and one exact occurrence of its quote; it preserves valid front matter verbatim.
`get` returns a plain `{ path, body, problems? }` snapshot or `undefined`. Computed locations
are available through `path()` methods. A selector does not follow a rename.

The executable proof starts a real loopback HTTP server around the existing run
host. It uploads a generated, playable quarter-second PCM WAV, starts actions,
and consumes their event streams. It checks that successful host inputs are
deleted while the kept recording retains its hash. Undeclared text and nested
binary files are fingerprinted before and after note creation and correction.
The proof also exercises duplicate destinations, declared-name collisions,
read-only actions, failed copies, absent or ambiguous quotes, malformed notes,
static symlinks, notes-first creation, and concurrent same-name keeps. Every
refused operation checks that existing interview files stayed unchanged. A failed
copy into a new interview is also checked: only an empty directory may remain.

## What the experiment establishes

The small caller can use the real upload lifetime without storing its temporary
reference. Keeping bytes and creating notes are independent writes: a later notes
failure leaves the recording kept. Only `notes.md` changes during correction;
the directory does not become a merged record. A flat Markdown collection can
keep its existing `add`, `set`, and `edit` API.

## Limits

This is a disk-only prototype. It borrows the action's write guard and app lock
through a throwing `folder.update` callback; production needs an owned filesystem
operation instead. It rejects static symlinks and opens document reads without
following the final link. Parent checks still race uncoordinated outside moves;
this is not a filesystem sandbox. Staged files use the destination filesystem's
hard-link support, with no overwrite fallback. A failed creation or crash can
leave empty directories; a crash can also leave a hidden local staging file.
There is no recovery command or multi-file
transaction. Returned success does not promise power-loss durability.

Malformed or unclosed front matter and UTF-8 byte-order marks refuse editing.
Only regular UTF-8 Markdown files are supported. Uploads still have the existing
15 MiB host limit. Failed runs retain host inputs until the host's TTL; these
proof inputs remain inside the disposable runtime. The API does not choose which
recording to play or replace later. These files should be deleted or absorbed
when the experiment's result becomes a production decision.
