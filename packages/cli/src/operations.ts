/**
 * The platform's operations (ADR-0817, ADR-0827), in the order `--help`
 * lists them: each one description, which the CLI renders as a command and
 * `epicenter mcp` as a tool. Each operation's code is a package function
 * behind a thin module here, loaded only when it runs, so `--help` and
 * `tools/list` start without the folder engine.
 *
 * A folder is named by its path or its name in the Epicenter folder (a
 * relative path reads from the working directory), a folder on the server
 * by its id, a person by the email they sign in with, and a moment by a
 * change's number, a mark's name, or a time.
 */
import { type TSchema, Type } from 'typebox';
import { defineOperation, type Operation, withCode } from './operation.ts';

const Nullable = <T extends TSchema>(schema: T) =>
	Type.Union([schema, Type.Null()]);
const Strings = Type.Array(Type.String());

const dir = (what = 'this directory') =>
	Type.Optional(
		Type.String({
			description: `A folder in the Epicenter folder, by its path or name; ${what} when absent.`,
		}),
	);
const moment = (description: string) => Type.String({ description });
const MOMENT =
	"a change's number, a mark's name, or a time (ISO 8601, or anything Date reads)";

const Member = Type.Object({
	email: Type.String(),
	name: Type.String(),
	role: Type.String(),
	you: Type.Boolean(),
});
const Invitee = Type.Object({ email: Type.String(), role: Type.String() });
const ListedFolder = Type.Object({
	id: Type.String(),
	title: Nullable(Type.String()),
	role: Type.String(),
	members: Type.Array(Member),
	invited: Type.Array(Invitee),
	apps: Strings,
});
const PendingShare = Type.Object({
	folder: Type.String(),
	title: Nullable(Type.String()),
	role: Type.String(),
	from: Nullable(Type.Object({ email: Type.String(), name: Type.String() })),
});
const Refused = Type.Array(
	Type.Object({ path: Type.String(), reason: Type.String() }),
);
const Outcome = Type.Union([
	Type.Literal('synced'),
	Type.Literal('retry'),
	Type.Literal('deletions'),
]);
/** One folder's sync: synced (with its report), kept by Git, or waiting. */
const FolderSync = Type.Object({
	folder: Type.String({
		description: 'Where the folder is, on this computer.',
	}),
	id: Type.Optional(Type.String({ description: 'Its id on the server.' })),
	made: Type.Optional(Type.Boolean()),
	joined: Type.Optional(Type.Boolean()),
	git: Type.Optional(Type.Literal(true)),
	waiting: Type.Optional(Type.String()),
	unchanged: Type.Optional(Type.Literal(true)),
	error: Type.Optional(Type.String()),
	outcome: Type.Optional(Outcome),
	passes: Type.Optional(Type.Number()),
	pulled: Type.Optional(Strings),
	pushed: Type.Optional(Strings),
	merged: Type.Optional(Strings),
	conflicts: Type.Optional(Strings),
	kept: Type.Optional(Strings),
	refused: Type.Optional(Refused),
	deletions: Type.Optional(Strings),
});
/** Which folder a folder not synced here is: the person answers with `join` or `create`. */
const Question = Type.Object({
	folder: Type.String(),
	path: Type.String(),
	candidates: Type.Array(
		Type.Object({
			id: Type.String(),
			title: Nullable(Type.String()),
			members: Type.Array(Member),
			matchedBy: Type.String(),
			alone: Type.Boolean(),
		}),
	),
	preselected: Nullable(Type.String()),
	madeBy: Nullable(Type.String()),
});
const SyncOutput = {
	sync: Type.Optional(FolderSync),
	question: Type.Optional(Question),
};
const LoggedChange = Type.Object({
	seq: Type.Number(),
	at: Type.String(),
	author: Type.String(),
	via: Type.String(),
	message: Nullable(Type.String()),
	digest: Type.String(),
	files: Type.Array(
		Type.Object({
			path: Type.String(),
			version: Nullable(Type.String()),
			size: Nullable(Type.Number()),
		}),
	),
	marks: Strings,
});
const Mark = Type.Object({
	name: Type.String(),
	seq: Type.Number(),
	at: Type.String(),
});
const FileAt = Type.Object({
	path: Type.String(),
	version: Type.String(),
	size: Nullable(Type.Number()),
});
const limit = (fallback: number) =>
	Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 1000,
			description: `At most this many, ${fallback} when absent.`,
		}),
	);

export const check = defineOperation({
	name: 'check',
	summary: 'report each file in a folder that does not fit its contract',
	details: `Checks every file in <dir>, by default this directory, against its contract:
<dir>/epicenter.json, or an app's contract named by --contract, a URL or a
file path. Prints one line per problem, compiler style: a path no collection
of the contract names, a note whose front matter does not parse, or one whose
fields do not fit. Hidden paths (.git, .DS_Store, ...), epicenter.json, and a
root AGENTS.md are not the contract's and are skipped. Exits 0 when every
file fits, 1 when one does not, and 2 when the contract or the folder cannot
be used. Never writes a file.`,
	args: [{ key: 'dir', label: '<dir>', optional: true }],
	options: [{ key: 'contract', value: '<url or path>' }],
	input: Type.Object({
		dir: Type.Optional(
			Type.String({ description: 'The folder; this directory when absent.' }),
		),
		contract: Type.Optional(
			Type.String({
				description:
					"An app's contract, a URL or a file path; the folder's epicenter.json when absent.",
			}),
		),
	}),
	output: Type.Object({
		files: Type.Number(),
		issues: Type.Array(
			Type.Object({
				path: Type.String(),
				line: Type.Optional(Type.Number()),
				message: Type.String(),
			}),
		),
		exitCode: Type.Number(),
	}),
});

export const format = defineOperation({
	name: 'format',
	summary: "rewrite every note a folder's contract claims in house style",
	details: `Rewrites every note in <dir>, by default this directory, that a collection
of its contract names (<dir>/epicenter.json, or --contract, a URL or a file
path), in house style: the contract's fields first in its order, other keys
after them sorted, block YAML, the body untouched. A note whose front matter
does not parse is left as it is and named. Each note is replaced only while
it still holds the bytes read. Exits 0 when every note is in house style, 1
when one was left as it is, and 2 when the contract or the folder cannot be
used.`,
	args: [{ key: 'dir', label: '<dir>', optional: true }],
	options: [{ key: 'contract', value: '<url or path>' }],
	input: check.input,
	output: Type.Object({
		formatted: Strings,
		unchanged: Type.Number(),
		refused: Refused,
		exitCode: Type.Number(),
	}),
});

export const status = defineOperation({
	name: 'status',
	summary:
		"the folders in the Epicenter folder, each one's state, and the shares waiting for you",
	details: `Lists every folder in the Epicenter folder (~/Epicenter, or ~/Epicenter Dev
in development): its title, and whether it is on this computer only, synced,
shared (with who holds it), kept by Git, or a link to a folder outside the
Epicenter folder; Epicenter syncs neither of the last two. A folder on this
computer only names the folders it could be. Below them, the shares waiting
for you and the folders you hold that this computer does not. It says so when
the Epicenter folder is inside a file-sync service, which Epicenter refuses to
sync, and when it is itself a Git repository. Signed out or offline, it lists
what this computer holds.`,
	input: Type.Object({}),
	output: Type.Object({
		root: Type.String(),
		folders: Type.Array(
			Type.Object({
				name: Type.String(),
				path: Type.String(),
				title: Nullable(Type.String()),
				state: Type.String(),
				folder: Nullable(Type.String()),
				members: Nullable(Type.Array(Member)),
				role: Nullable(Type.String()),
				unlisted: Nullable(Type.String()),
				question: Nullable(
					Type.Object({
						candidates: Type.Array(
							Type.Object({
								folder: ListedFolder,
								matchedBy: Type.String(),
								alone: Type.Boolean(),
							}),
						),
						preselected: Nullable(Type.String()),
						silent: Nullable(Type.String()),
					}),
				),
			}),
		),
		pending: Type.Array(PendingShare),
		elsewhere: Type.Array(ListedFolder),
		unreadable: Type.Array(
			Type.Object({ name: Type.String(), reason: Type.String() }),
		),
		fileSync: Nullable(Type.Object({})),
		git: Nullable(Type.String()),
		offline: Nullable(Type.String()),
	}),
});

export const init = defineOperation({
	name: 'init',
	summary:
		"write a folder's epicenter.json, proposing collections from its files",
	details: `Writes <path>'s epicenter.json (this directory by default): its title (the
directory's name, or --title), and the collections its files suggest, a
pattern per directory, {name} the item's file name. A directory's notes
become one collection with a field for each front matter key, typed by its
values; its other files another. Files directly in the folder, and notes
whose front matter does not read, are left out, each with why. A folder
needs no epicenter.json to sync; it adds checking. Refuses a folder that has
one. --dry-run prints the proposal and writes nothing.`,
	args: [{ key: 'path', label: '<path>', optional: true }],
	options: [{ key: 'title', value: '<title>' }, { key: 'dryRun' }],
	input: Type.Object({
		path: Type.Optional(
			Type.String({ description: 'The folder; this directory when absent.' }),
		),
		title: Type.Optional(
			Type.String({
				description: "Its title; the directory's name when absent.",
			}),
		),
		dryRun: Type.Optional(
			Type.Boolean({ description: 'Propose, and write nothing.' }),
		),
	}),
	output: Type.Object({
		init: Type.Object({
			folder: Type.String(),
			written: Type.Boolean(),
			contract: Type.Object({}),
			left: Refused,
		}),
	}),
});

export const sync = defineOperation({
	name: 'sync',
	summary:
		'sync a folder in the Epicenter folder with its folder on the server, asking which one first when it is not synced here',
	details: `Syncs <folder> (a folder in the Epicenter folder, by its path or name; the
current directory by default) with its folder on the server, with no Git on
this computer: what changed on either side since the last sync is copied to
the other, and a note both sides changed merges by Epicenter's rules, front
matter by key with this computer's change winning a key both changed, and the
body by line with one conflict block per clash. An edit beats a delete, and a
file both sides replaced keeps this computer's; the other stays in the
folder's history.

What this computer synced is recorded at the Epicenter folder's root, one
record per folder, and a folder syncs from that record only when this
directory is proven the one that synced it: the same inode and birth time, or,
after a move to a new computer, the same name and exactly the same files in a
folder only you hold. A folder not proven so asks which folder it is before
anything is sent, listing the folders you hold that it could be (by name or
title, with who holds them): answer --join <id>, or --create to make it a new
folder. With nothing it could be, it becomes a new folder; with one folder you
hold alone, it joins that one. A join starts from first contact, which never
deletes on either side. A folder kept by Git, and a link to a folder outside
the Epicenter folder, are never synced.

A sync that would delete 20 or more files on the server, or 5 or more that
are half the folder, sends nothing and says which: --push-deletions deletes
them there, and --restore-deletions brings them back here. --all syncs every
folder in the Epicenter folder that moved, asking the server once where every
folder is, and a folder an app made as if you had named it. With --json,
{"sync"} or {"question"}, or with --all {"every": [...], "warnings"}. Exits 0
when synced, 1 when a sync should run again, the repository refused a file (a
name differing only in case from one it holds), a folder asks which one it is,
or deletions wait for an answer, and 2 when it could not sync.`,
	args: [{ key: 'folder', label: '<folder>', optional: true }],
	options: [
		{ key: 'join', value: '<id>' },
		{ key: 'create' },
		{ key: 'pushDeletions' },
		{ key: 'restoreDeletions' },
		{ key: 'all' },
	],
	input: Type.Object({
		folder: dir(),
		join: Type.Optional(
			Type.String({
				description:
					"Answer a folder's question: sync it with the folder of this id.",
			}),
		),
		create: Type.Optional(
			Type.Boolean({
				description: "Answer a folder's question: make it a new folder.",
			}),
		),
		pushDeletions: Type.Optional(
			Type.Boolean({
				description: 'Delete on the server the files deleted here.',
			}),
		),
		restoreDeletions: Type.Optional(
			Type.Boolean({
				description: 'Bring back here the files deleted here.',
			}),
		),
		all: Type.Optional(
			Type.Boolean({
				description: 'Sync every folder in the Epicenter folder that moved.',
			}),
		),
	}),
	output: Type.Object({
		...SyncOutput,
		every: Type.Optional(
			Type.Array(
				Type.Object({
					sync: Type.Optional(FolderSync),
					question: Type.Optional(Question),
				}),
			),
		),
		warnings: Type.Optional(Strings),
	}),
});

export const clone = defineOperation({
	name: 'clone',
	summary:
		'list your folders, or bring one into the Epicenter folder by its id or title, and sync it',
	details: `Without <folder>, lists the folders you hold: id, title, and who holds them.
With one (its id, or its title when one folder has it), brings it into a new
folder in the Epicenter folder, named <name> or for its title, and syncs it,
taking its files.`,
	args: [
		{ key: 'folder', label: '<folder>', optional: true },
		{ key: 'name', label: '<name>', optional: true },
	],
	input: Type.Object({
		folder: Type.Optional(
			Type.String({
				description:
					'A folder you hold, by its id or title; absent to list them.',
			}),
		),
		name: Type.Optional(
			Type.String({
				description:
					"The new directory's name; the folder's title when absent.",
			}),
		),
	}),
	output: Type.Object({
		folders: Type.Optional(Type.Array(ListedFolder)),
		...SyncOutput,
	}),
});

export const log = defineOperation({
	name: 'log',
	summary: "the folder's changes on the server, newest first",
	details: `Lists the folder's changes on the server, newest first: each change's
number, time, author, what it wrote, and its marks, noting the one this folder
last agreed at. --path lists only the changes to one file, --at starts from a
moment, and --limit takes at most that many (20 by default). A moment is a
change's number, a mark's name, or a time.`,
	args: [{ key: 'dir', label: '<dir>', optional: true }],
	options: [
		{ key: 'path', value: '<path>' },
		{ key: 'at', value: '<moment>' },
		{ key: 'limit', value: '<n>' },
	],
	input: Type.Object({
		dir: dir(),
		path: Type.Optional(
			Type.String({
				description:
					'Only the changes to this file, by its path in the folder.',
			}),
		),
		at: Type.Optional(moment(`Start from this moment: ${MOMENT}.`)),
		limit: limit(20),
	}),
	output: Type.Object({
		log: Type.Array(LoggedChange),
		here: Nullable(
			Type.Number({ description: 'The change this folder last agreed at.' }),
		),
	}),
});

export const history = defineOperation({
	name: 'history',
	summary: "a file's versions on the server, who wrote each, and when",
	details: `Lists each version of the file at <path> (a file in a folder synced
here) on the server, newest first: the change that wrote it, when, who, its
version and size, or that it was deleted, with the change's marks. --at starts
from a moment; --limit takes at most that many (50 by default).`,
	args: [{ key: 'path', label: '<path>' }],
	options: [
		{ key: 'at', value: '<moment>' },
		{ key: 'limit', value: '<n>' },
	],
	input: Type.Object({
		path: Type.String({
			description: 'A file in a folder synced here, by its path on disk.',
		}),
		at: Type.Optional(moment(`Start from this moment: ${MOMENT}.`)),
		limit: limit(50),
	}),
	output: Type.Object({
		history: Type.Object({
			path: Type.String(),
			versions: Type.Array(
				Type.Object({
					seq: Type.Number(),
					at: Type.String(),
					author: Type.String(),
					via: Type.String(),
					version: Nullable(Type.String()),
					size: Nullable(Type.Number()),
					marks: Strings,
				}),
			),
		}),
	}),
});

export const show = defineOperation({
	name: 'show',
	summary: 'a file as the server holds it, or as it was at a moment',
	details: `Writes the file at <path> as the server holds it to stdout, or as it was
at --at <moment> (a change's number, a mark, or a time). With --json, its
bytes as "text" when they are UTF-8, else as "base64".`,
	args: [{ key: 'path', label: '<path>' }],
	options: [{ key: 'at', value: '<moment>' }],
	input: Type.Object({
		path: Type.String({
			description: 'A file in a folder synced here, by its path on disk.',
		}),
		at: Type.Optional(moment(`As it was at this moment: ${MOMENT}.`)),
	}),
	output: Type.Object({
		show: Type.Object({
			path: Type.String(),
			seq: Type.Number(),
			version: Type.String(),
			size: Nullable(Type.Number()),
			text: Type.Optional(Type.String()),
			base64: Type.Optional(Type.String()),
		}),
	}),
});

export const at = defineOperation({
	name: 'at',
	summary: "the folder's files as they were at a moment",
	details: `Lists the folder's files as they were at <moment> (a change's number, a
mark's name, or a time), each with its version and size.`,
	args: [
		{ key: 'moment', label: '<moment>' },
		{ key: 'dir', label: '<dir>', optional: true },
	],
	input: Type.Object({
		moment: moment(`The moment: ${MOMENT}.`),
		dir: dir(),
	}),
	output: Type.Object({
		at: Type.Object({
			moment: Type.String(),
			seq: Type.Number(),
			files: Type.Array(FileAt),
		}),
	}),
});

export const mark = defineOperation({
	name: 'mark',
	summary:
		"name the folder's last change, so history and the export reach it; or list its marks",
	details: `Names the folder's last change on the server <name>, so log, history,
show, at, diff, and restore reach it by name, and epicenter export --git writes
it as a tag. A name that marks another change stays unless --move. Without a
name, lists the folder's marks.`,
	args: [
		{ key: 'name', label: '<name>', optional: true },
		{ key: 'dir', label: '<dir>', optional: true },
	],
	options: [{ key: 'move' }],
	input: Type.Object({
		name: Type.Optional(
			Type.String({ description: 'The mark; absent to list the marks.' }),
		),
		dir: dir(),
		move: Type.Optional(
			Type.Boolean({ description: 'Move a mark that names another change.' }),
		),
	}),
	output: Type.Object({
		marks: Type.Optional(Type.Array(Mark)),
		mark: Type.Optional(Mark),
	}),
});

export const diff = defineOperation({
	name: 'diff',
	summary:
		'the files changed since the last sync, or on the server since a moment',
	details: `Without --since, lists the files this folder added, changed, or deleted
since its last sync, read from the folder alone. With --since <moment> (a
change's number, a mark, or a time), lists the files the server changed
between that moment and now.`,
	args: [{ key: 'dir', label: '<dir>', optional: true }],
	options: [{ key: 'since', value: '<moment>' }],
	input: Type.Object({
		dir: dir(),
		since: Type.Optional(
			moment(`The files the server changed since this moment: ${MOMENT}.`),
		),
	}),
	output: Type.Object({
		since: Nullable(Type.String()),
		diff: Type.Array(
			Type.Object({
				path: Type.String(),
				change: Type.Union([
					Type.Literal('added'),
					Type.Literal('changed'),
					Type.Literal('deleted'),
				]),
			}),
		),
	}),
});

export const restore = defineOperation({
	name: 'restore',
	summary:
		"give a folder's files, or one with --path, back what they held at a moment, as a new change",
	details: `Makes one change on the server that gives the folder's files back the
versions they held at <moment> (a change's number, a mark, or a time),
removing files made since, or restores only the file at --path. It names
versions the server keeps, so no bytes travel, and the history keeps
everything in between. Run epicenter sync to bring it here.`,
	args: [
		{ key: 'moment', label: '<moment>' },
		{ key: 'dir', label: '<dir>', optional: true },
	],
	options: [{ key: 'path', value: '<path>' }],
	input: Type.Object({
		moment: moment(`The moment: ${MOMENT}.`),
		dir: dir(),
		path: Type.Optional(
			Type.String({
				description: 'Only this file, by its path in the folder.',
			}),
		),
	}),
	output: Type.Object({
		restored: Type.Object({
			moment: Type.String(),
			folder: Type.String(),
			written: Strings,
			removed: Strings,
			cursor: Nullable(Type.String()),
		}),
	}),
});

export const exportGit = defineOperation({
	name: 'export',
	summary:
		"write a folder's history into a Git repository, adding what is new since the last export",
	details: `Writes the history of the folder <dir> names (this directory by default)
into the Git repository at --git <repository>, made when absent: one commit per
change on main, with its author and time, notes and epicenter.json as files and
every other file as a Git LFS pointer, its object in .git/lfs/objects, and each
mark as a tag (projection v2). Run again, it adds only the changes since the
last export, and a new export of the same history makes the same commits; it
never continues an export in another projection. A file whose bytes were
purged keeps its pointer and is named. Push the repository anywhere to keep a
mirror.`,
	args: [{ key: 'dir', label: '<dir>', optional: true }],
	options: [{ key: 'git', value: '<repository>' }],
	input: Type.Object({
		dir: dir(),
		git: Type.String({
			description: 'The Git repository to write, a directory made when absent.',
		}),
	}),
	output: Type.Object({
		export: Type.Object({
			dir: Type.String(),
			folder: Type.String(),
			from: Type.Number(),
			to: Type.Number(),
			tags: Strings,
			purged: Type.Array(
				Type.Object({
					seq: Type.Number(),
					path: Type.String(),
					version: Type.String(),
				}),
			),
			skipped: Type.Array(
				Type.Object({
					seq: Type.Number(),
					path: Type.String(),
					reason: Type.String(),
				}),
			),
			checkout: Type.String(),
		}),
	}),
});

export const importGit = defineOperation({
	name: 'import',
	summary:
		"make a folder from a Git repository's history, in the Epicenter folder and synced; or resume or abandon one that stopped",
	details: `Reads the Git repository at --git (a path or a URL) without writing it, and
makes a folder of its history: each commit of the default branch's first-parent
line, or --branch's, becomes a change with its author, time, and message, a tag
becomes a mark, and Git LFS files become their bytes. Files keep their bytes as
they are; epicenter format rewrites front matter as its own step. Submodules,
links, and hidden files are left out, each named. The folder is written to a new
directory in the Epicenter folder (--name, or the repository's), without .git,
and synced. --replace-original moves a repository on this computer aside, its
.git kept within it, and leaves a link at its path to the new folder; it refuses
a repository with uncommitted changes.

An import that stops midway (a Git LFS object missing, the network gone) lands
the changes it finished, and this computer remembers it until it is done.
--resume continues it, the one of --git or the only one waiting, from the
change after the last the server holds, sending none twice. --abandon <folder>
(its id, or the repository or name it was given) gives one up: its folder is
deleted on the server, which only happens while it still imports, and the
directory it was writing here is removed.`,
	options: [
		{ key: 'git', value: '<path or URL>' },
		{ key: 'branch', value: '<name>' },
		{ key: 'name', value: '<name>' },
		{ key: 'replaceOriginal' },
		{ key: 'resume' },
		{ key: 'abandon', value: '<folder>' },
	],
	input: Type.Object({
		git: Type.Optional(
			Type.String({
				description: 'The Git repository to read, a path or a URL.',
			}),
		),
		branch: Type.Optional(
			Type.String({
				description: 'The branch to read; its default when absent.',
			}),
		),
		name: Type.Optional(
			Type.String({
				description: "The new directory's name; the repository's when absent.",
			}),
		),
		replaceOriginal: Type.Optional(
			Type.Boolean({
				description:
					'Move a repository on this computer aside, its .git within it, and leave a link at its path to the new folder.',
			}),
		),
		resume: Type.Optional(
			Type.Boolean({
				description:
					'Continue the import of --git, or the only one waiting, that stopped midway.',
			}),
		),
		abandon: Type.Optional(
			Type.String({
				description:
					'Give up an import that stopped midway, by its folder id, or the repository or name it was given.',
			}),
		),
	}),
	output: Type.Object({
		import: Type.Optional(
			Type.Object({
				folder: Type.String(),
				path: Type.String(),
				branch: Type.String(),
				commits: Type.Number(),
				changes: Type.Number(),
				resumed: Type.Number(),
				marks: Strings,
				warnings: Strings,
				original: Nullable(
					Type.Object({ movedTo: Type.String(), link: Type.String() }),
				),
			}),
		),
		abandon: Type.Optional(
			Type.Object({
				folder: Type.String(),
				server: Type.String(),
				removed: Nullable(Type.String()),
			}),
		),
	}),
});

const folderTarget = Type.String({
	description:
		'A folder: its id, or its path or name in the Epicenter folder once it synced here.',
});

export const share = defineOperation({
	name: 'share',
	summary:
		'invite an email to a folder, or change the role of someone who holds it; or list who holds it',
	details: `Invites <email> to the folder (a path that has synced, or a folder id), as
a member, or with --role reader as a reader, who syncs it without changing
it. The folder is theirs once whoever signs in with that email, verified,
accepts it (epicenter accept), whether they have an account now or sign up
later; the answer is the same either way. For someone who holds it already,
it changes their role. Without <email>, lists who holds the folder and who
is invited. Every member shares; a reader does not. Exits 2 when refused.`,
	args: [
		{ key: 'folder', label: '<folder>' },
		{ key: 'email', label: '<email>', optional: true },
	],
	options: [{ key: 'role', value: 'member|reader' }],
	input: Type.Object({
		folder: folderTarget,
		email: Type.Optional(
			Type.String({
				description:
					'Who to invite, by the email they sign in with; absent to list who holds it.',
			}),
		),
		role: Type.Optional(
			Type.Union([Type.Literal('member'), Type.Literal('reader')], {
				description: 'member (the default) or reader.',
			}),
		),
	}),
	output: Type.Object({
		share: Type.Optional(
			Type.Object({
				folder: Type.String(),
				person: Type.String(),
				role: Type.String(),
				pending: Type.Boolean(),
			}),
		),
		folder: Type.Optional(ListedFolder),
	}),
});

export const unshare = defineOperation({
	name: 'unshare',
	summary:
		'take a person out of a folder or cancel their invitation; with your own email, leave it or decline',
	details: `Takes the person who signs in as <email> out of the folder, or cancels the
invitation to <email>; their next sync is refused, and the files they have
stay with them. Every member does this; with your own email, you leave the
folder, or decline an invitation waiting for you. When the last person
leaves, the folder is deleted from the server.`,
	args: [
		{ key: 'folder', label: '<folder>' },
		{ key: 'email', label: '<email>' },
	],
	input: Type.Object({
		folder: folderTarget,
		email: Type.String({
			description: 'Who to take out, by the email they sign in with.',
		}),
	}),
	output: Type.Object({
		unshare: Type.Object({
			folder: Type.String(),
			person: Type.String(),
			removed: Type.Boolean(),
			folderGone: Type.Boolean(),
		}),
	}),
});

export const accept = defineOperation({
	name: 'accept',
	summary:
		'accept a share into the Epicenter folder, or list the shares waiting for you',
	details: `Accepts the share of <folder> (its id, or its title) waiting for you, and
brings it into the Epicenter folder beside your own, in a new folder named
for its title. Without <folder>, lists the shares waiting for you.`,
	args: [{ key: 'folder', label: '<folder>', optional: true }],
	input: Type.Object({
		folder: Type.Optional(
			Type.String({
				description:
					'The share, by its folder id or title; absent to list them.',
			}),
		),
	}),
	output: Type.Object({
		pending: Type.Optional(Type.Array(PendingShare)),
		accept: Type.Optional(
			Type.Object({
				folder: Type.String(),
				path: Type.String(),
				sync: Type.Object({}),
			}),
		),
	}),
});

const attachInput = Type.Object({
	folder: folderTarget,
	app: Type.String({
		description:
			'The app, by the client id it signs in as, such as so.epicenter.todos.',
	}),
});
const Attached = Type.Object({ folder: Type.String(), app: Type.String() });

export const attach = defineOperation({
	name: 'attach',
	summary: 'let an app reach a folder: use this folder with it',
	details: `Lets the app that signs in as <app> (such as so.epicenter.todos) reach the
folder: an app reaches only the folders attached to it, and its first sync
attaches the folder it makes. Only Epicenter and this command attach one.`,
	args: [
		{ key: 'folder', label: '<folder>' },
		{ key: 'app', label: '<app>' },
	],
	input: attachInput,
	output: Type.Object({ attach: Attached }),
});

export const detach = defineOperation({
	name: 'detach',
	summary: 'stop an app reaching a folder',
	details:
		'Stops the app <app> reaching the folder. Its files stay where they are.',
	args: [
		{ key: 'folder', label: '<folder>' },
		{ key: 'app', label: '<app>' },
	],
	input: attachInput,
	output: Type.Object({ detach: Attached }),
});

/** Every platform operation, in the order `--help` lists them, with its code. */
export const OPERATIONS: readonly Operation[] = [
	withCode(check, async () => (await import('./contract-commands.ts')).check),
	withCode(format, async () => (await import('./contract-commands.ts')).format),
	withCode(status, async () => (await import('./folder-commands.ts')).status),
	withCode(init, async () => (await import('./folder-commands.ts')).init),
	withCode(sync, async () => (await import('./sync/commands.ts')).sync),
	withCode(clone, async () => (await import('./sync/commands.ts')).clone),
	withCode(log, async () => (await import('./sync/history.ts')).log),
	withCode(history, async () => (await import('./sync/history.ts')).history),
	withCode(show, async () => (await import('./sync/history.ts')).show),
	withCode(at, async () => (await import('./sync/history.ts')).at),
	withCode(mark, async () => (await import('./sync/history.ts')).mark),
	withCode(diff, async () => (await import('./sync/history.ts')).diff),
	withCode(restore, async () => (await import('./sync/history.ts')).restore),
	withCode(
		exportGit,
		async () => (await import('./git/commands.ts')).exportGit,
	),
	withCode(
		importGit,
		async () => (await import('./git/commands.ts')).importGit,
	),
	withCode(share, async () => (await import('./folder-commands.ts')).share),
	withCode(unshare, async () => (await import('./folder-commands.ts')).unshare),
	withCode(accept, async () => (await import('./folder-commands.ts')).accept),
	withCode(attach, async () => (await import('./folder-commands.ts')).attach),
	withCode(detach, async () => (await import('./folder-commands.ts')).detach),
];
