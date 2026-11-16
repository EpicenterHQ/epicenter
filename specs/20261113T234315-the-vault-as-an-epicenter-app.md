# The vault as an Epicenter app

**Date**: 2026-11-13
**Status**: In Progress (1.1 to 1.3 ran in a temporary home; nothing is on the home yet)
**Owner**: Braden

## One sentence

The vault's repository becomes the data repository of one `vault` app, whose
`epicenter.ts` declares pages, journal, and collections and carries the
publishing and video actions, and each outside source the vault mirrors today
becomes an app of its own.

## How to read this spec

```txt
Read first:
  Current state
  Target shape
  What was run
  Implementation plan

Read before deciding:
  Semantic shifts
  Open questions

Reference:
  The draft epicenter.ts
  Where each command goes
```

This is item 1 of "Next" in `docs/vision.md`: the vault as a folder app, served
from the home and used from the phone for a month (ADR-0897). No new ADR is
proposed here. Record one after phase 1 has run on the home, not before.

## Current state

`~/Code/vault` is one Git repository holding four different things:

```txt
~/Code/vault/                      one repository, 8.46 GiB packed
  pages/ journal/ collections/     what the person wrote (3,307 + 174 + 33 files)
  crm/ lists/ recipes/ ...         smaller authored folders
  cli.ts scripts/ publishing/      the code: one CLI, about 35 commands
  remotion/                        the video renderer
  .calendar/ .todoist/ .photos/    mirrors of Google Calendar, Todoist, Google Photos (ignored)
  paxo/ recordings/                imported voice recordings and transcripts
  folder.ts epicenter.json         a declaration for @epicenter/folder, the waiting product
```

Two things are wrong today:

1. `node_modules/@epicenter/folder` links to `../worktrees/epicenter-stable`,
   which no longer exists. `publishing/rows.ts` imports it, and `check`,
   `collections`, `publish record`, `page rename`, `account rename`, every
   `video` command, and the `instagram` and `tiktok` commands import
   `rows.ts`. This spec did not run them; the import chain says they fail.
   `bun run epicenter query`, which the `vault-publishing` and `plan-pages`
   skills call, is gone with the same worktree.
2. Five mirrors of outside sources were each built separately: Calendar and
   Todoist as Markdown rebuilt by `materialize`, Photos as SQLite, Paxo and
   voice memos as add-only imports. Each has its own cursor, freshness, and
   ignore rule.

## Target shape

```txt
~/Epicenter/apps/
  vault/                    the code repository
    epicenter.ts            collections and actions (drafted below)
    lib/                    today's publishing/*.ts, ported off @epicenter/folder
    remotion/               the renderer, unchanged
    AGENTS.md CONTEXT.md    the vault's rules and vocabulary
    .agents/skills/         the writing and publishing skills
    docs/adr/               the publishing model's records
    data/                   today's vault repository, its history intact
      pages/<page>.md       and each page's folder: script.md, narration.mp3, ...
      journal/<entry>.md
      collections/<name>.md
      crm/ lists/ recipes/ applications/ imessage/ quick/ platforms/
  calendar/                 Google Calendar: pull, show, remove-text, delete
  photos/                   Google Photos: pull, search, and the browse UI
  recordings/               Paxo and voice memos now, Whispering's folder later
  tasks/                    exists; Todoist becomes an intake an agent empties into it
```

The data repository is the existing repository with its code removed, so a
page keeps its path (`pages/<page>.md`) and its history. ADR-0897 asks that
the vault's history not move; this layout moves none of it.

By the vision's own table, "a new source, sign-in, or contract with its own
lifetime" is a new app. Calendar has its own Google sign-in, its own cache,
and two destructive verbs, so it is `calendar`, not `vault calendar` as the
vision's example has it. That example should change.

### Where each top-level folder goes

| Today | Goes to | Why |
| --- | --- | --- |
| `pages/`, `journal/`, `collections/`, `crm/`, `lists/`, `recipes/`, `applications/`, `imessage/`, `quick/`, `platforms/`, `publishing-recipes/` | `vault/data/` (stays where it is) | what the person wrote |
| `cli.ts`, `scripts/`, `publishing/`, `remotion/`, `docs/`, `specs/`, `AGENTS.md`, `CONTEXT.md`, `.agents/`, `.claude/` | `vault/` code repository | code and its instructions |
| `clips/` | `vault/data/clips/` for now | only video reads it; split it out if a second reader appears |
| `.calendar/`, `scripts/calendar/` | `calendar` app | its own source and sign-in |
| `.photos/`, `scripts/photos*` | `photos` app | its own source, cache, and UI |
| `paxo/`, `recordings/` | `recordings` app | one shape, arrivals with audio beside the transcript |
| `.todoist/`, `scripts/todoist/` | an intake for `tasks` | ADR-0898's example |
| `tasks/` (21 daily files, no reader) | retire into `tasks` | three task systems today |
| `migration-queues/`, `_dictation-archive/` | `vault/data/`, not collections | finite queues the skills empty |
| `folder.ts`, `epicenter.json`, `kv.json`, `.epicenter/`, `apps/tab-manager/`, `tab-manager/`, `editions/`, `productions/`, `publish/`, `.publishing/`, `technical-notes/`, `pull-request-writing/`, `skill-archive/` | delete | dead, or the waiting product's |
| `listen`, `search`, `brave-tab-review` | stay plain scripts, outside the app | not about the vault |

## What was run

The draft `epicenter.ts` below ran from source (`packages/cli/src/bin.ts`) in
a temporary home, over a copy of every top-level Markdown file in `pages/`,
`journal/`, and `collections/`. The copy was deleted afterwards. Nothing in
`~/Code/vault` or `~/Epicenter` was touched.

| Call | Result |
| --- | --- |
| `vault pages list` | 3,307 rows in 0.44 s; 1.3 MB of JSON; 2 files with a problem |
| `vault journal list` | 174 rows, no problems |
| `vault collections list` | 33 rows, 3 with a problem |
| `vault check` | 3,514 files in 0.28 s; 5 issues, the same 5 |
| `vault query "<sql>"` | 0.31 s, building its tables in memory on each call |
| `vault query "delete from pages"` | refused: "attempt to write a readonly database" |
| `vault record <page> <account> <url>` | one commit, `vault: record <page>`, touching one file |
| the same `record` again | `recorded: false`, no commit |

What this settles:

- **The fields fit.** Five files of 3,514 report a problem, and all five are
  the two shifts named below (`slug: null`, and `collections/README.md`).
- **Speed is not the problem; size is.** Reading every page takes under half a
  second, so `query` needs no index file. But `pages list` answers 1.3 MB,
  which no agent should take over MCP. Agents use `query`; `list` is for the
  UI and for scripts.
- **The working tree is clean.** `git status` in the vault shows no untracked
  file that is not ignored, so `serve`'s first snapshot sweeps nothing in.

### Second run: a clone of the real repository as `data/`

A local `git clone` of `~/Code/vault` (2,235 commits, 15,196 tracked files)
replaced the app's `data/` in the temporary home. Its `origin` was removed at
once, so nothing could push to the vault, and the clone was deleted
afterwards. The vault's `HEAD` and working tree are as they were.

| Call | Result |
| --- | --- |
| `git clone` from the local path | 2.4 s; objects are hard links, the checkout is 0.29 GiB |
| `epicenter vault` | accepts the clone as the data repository as it is |
| `vault check` | 3,513 files in 0.32 s; the same 5 issues |
| `vault pages list`, companion files present | 3,306 rows in 0.33 s |
| `epicenter history vault` | lists the vault's own commits as `data`, in 0.12 s |
| `epicenter sync vault -m` | commits the `.gitignore` change in 0.58 s; "no origin" |
| `vault record` | 0.51 s; one commit carrying `Code-Commit:` |
| `vault pages set <path> --resonance 4` | one commit, `vault: pages set <path>` |
| `epicenter undo vault`, twice | both reverted; the page is byte for byte what it was, YAML front matter included |
| `bun test ./epicenter.test.ts` | 8 pass |
| `tsc -p tsconfig.json` | clean |
| walking the real `pages/` read-only, all media present | 4,896 files in 246 folders in 22 ms |

- **An existing repository works as `data/` unchanged.** It needs only the
  two `*.local` lines in its `.gitignore`.
- **Media beside the pages costs nothing.** `list` walks names and reads only
  the files its template matches.
- **`undo` restores the old front matter exactly,** so the rewrite in shift 2
  is reversible one commit at a time.

What was not run: `serve`, a UI, or a phone; a clone or push over the network
(the repository is 8.46 GiB packed); anything in `publishing/` or `remotion/`.

## The draft `epicenter.ts`

This is the file that ran. The app's `package.json` names `typebox` (1.1.23,
the version `@epicenter/app` uses) and, for the typecheck, `@types/bun` and
`typescript`; its `tsconfig.json` is Tasks' own.

```ts
import { Database } from 'bun:sqlite';
import {
	defineAction,
	defineApp,
	defineCollection,
	field,
	FileError,
	localDay,
} from '@epicenter/app';
import Type from 'typebox';

const kebab = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
/** An account, `<platform>/<handle>`: `instagram/bradencodes`. */
const account = '^[a-z]+/[a-z0-9._-]+$';

/** One row of a page's `posts`: the day it is meant to go out, the account, and its link once it is up. */
const post = Type.Object(
	{
		on: Type.Optional(Type.String({ format: 'date' })),
		to: Type.String({ pattern: account }),
		url: Type.Optional(
			Type.Union([
				Type.Literal('private'),
				Type.String({ format: 'uri', pattern: '^https?://' }),
			]),
		),
	},
	{ additionalProperties: false },
);

/**
 * Every note I have written. A draft has no `finishedAt`; a public page has
 * `finishedAt` and a `slug`. Nothing stores a status.
 */
const pages = defineCollection({
	path: 'data/pages/{page}.md',
	description: 'page',
	fields: {
		title: field.text(),
		subtitle: field.text({ optional: true }),
		date: field.text({ description: 'the day it was first written' }),
		finishedAt: field.date({
			optional: true,
			description: 'The day I judged the writing finished; absent on a draft',
		}),
		slug: field.text({
			optional: true,
			pattern: kebab,
			description: 'lowercase words joined by hyphens: its public address',
		}),
		aliases: field.tags({ description: 'Earlier public addresses' }),
		timezone: field.text(),
		resonance: field.integer({ optional: true, min: 1, max: 5 }),
		tags: field.tags(),
		posts: Type.Optional(Type.Array(post, { default: [] })),
		resource: field.text({ optional: true }),
		collections: field.tags({ description: 'The collections it belongs to' }),
		look: field.text({ optional: true, pattern: kebab }),
	},
});

const journal = defineCollection({
	path: 'data/journal/{entry}.md',
	description: 'journal entry',
	fields: {
		title: field.text(),
		date: field.text(),
		timezone: field.text(),
		resonance: field.select(
			['light', 'curious', 'meaningful', 'profound', 'transformative'],
			{ optional: true },
		),
		tags: field.tags(),
	},
});

/** A set of pages I gather for an audience, and the accounts that post it. */
const collections = defineCollection({
	path: 'data/collections/{name}.md',
	description: 'collection',
	fields: {
		title: field.text(),
		description: field.text({ optional: true }),
		bio: field.text({ optional: true }),
		slug: field.text({ optional: true, pattern: kebab }),
		pace: field.select(['daily', 'weekly', 'as-fits'], { optional: true }),
		accounts: Type.Optional(
			Type.Record(Type.String({ pattern: account }), Type.Object({}), {
				default: {},
			}),
		),
	},
});

/** Complete the earliest pending row for the account, or record a new post today. */
const record = defineAction({
	description:
		'Record that a page went up on an account: fills the earliest planned post to that account that has no link, or adds a post dated today. The same link recorded twice changes nothing. Give no url for a room with no public link',
	input: {
		page: field.text({ description: "The page's file name without .md" }),
		account: field.text({ pattern: account, description: '<platform>/<handle>' }),
		url: field.text({ optional: true, description: 'Its link; private when absent' }),
	},
	positional: ['page', 'account', 'url'],
	annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
	run: async ({ page, account, url = 'private' }) => {
		if (url !== 'private' && !/^https?:\/\//.test(url))
			throw new Error('A link starts with http:// or https://');
		const path = pages.pathOf({ page });
		let recorded = false;
		await pages.update({ path }, (found) => {
			if (!found) throw FileError.Missing({ path }).error;
			const posts = found.posts ?? [];
			recorded = !posts.some((row) => row.to === account && row.url === url);
			if (!recorded) return {};
			let earliest = -1;
			for (const [at, row] of posts.entries()) {
				if (row.to !== account || row.url !== undefined) continue;
				const day = row.on ?? '9999-99-99';
				if (earliest === -1 || day < (posts[earliest]?.on ?? '9999-99-99'))
					earliest = at;
			}
			return {
				posts:
					earliest === -1
						? [...posts, { on: localDay(), to: account, url }]
						: posts.map((row, at) => (at === earliest ? { ...row, url } : row)),
			};
		});
		return { page: path, account, url, recorded };
	},
});

/** Every file that does not fit, and every rule across files that is broken. */
const check = defineAction({
	description:
		'Name every page, journal entry, and collection whose fields do not fit, every page with a slug and no finishedAt, every page in a collection that does not exist, and every account two collections claim. Changes nothing',
	input: {},
	annotations: { readOnlyHint: true, openWorldHint: false },
	run: async () => {
		const [allPages, entries, sets] = await Promise.all([
			pages.list(),
			journal.list(),
			collections.list(),
		]);
		const issues: string[] = [];
		for (const row of [...allPages, ...entries, ...sets])
			for (const problem of row.problems ?? [])
				issues.push(`${row.path}: ${problem}`);
		const names = new Set(sets.map((set) => set.name));
		const owner = new Map<string, string>();
		for (const set of sets)
			for (const handle of Object.keys(set.accounts ?? {})) {
				const first = owner.get(handle);
				if (first) issues.push(`${handle}: in both ${first} and ${set.name}`);
				owner.set(handle, set.name);
			}
		for (const page of allPages) {
			if (page.slug !== undefined && page.finishedAt === undefined)
				issues.push(`${page.path}: slug requires finishedAt`);
			for (const name of page.collections ?? [])
				if (!names.has(name)) issues.push(`${page.path}: no collection ${name}`);
		}
		return { files: allPages.length + entries.length + sets.length, issues };
	},
});

/** One read-only SQL statement over the fields of every record, as tables named for the collections. */
const query = defineAction({
	description:
		"Answer one read-only SQL statement over the tables pages, journal, and collections: a column per field, plus path. Lists and objects are JSON text, so json_each(pages.posts) gives a page's posts. Bodies are not in the tables. With no sql, describes each table",
	input: { sql: field.text({ optional: true, description: 'One SELECT statement' }) },
	positional: ['sql'],
	annotations: { readOnlyHint: true, openWorldHint: false },
	run: async ({ sql }) => {
		const db = new Database(':memory:');
		const tables = { pages, journal, collections };
		const described: Record<string, string[]> = {};
		for (const [name, collection] of Object.entries(tables)) {
			const rows: Record<string, unknown>[] = await collection.list();
			const columns = [
				'path',
				...new Set(rows.flatMap((row) => Object.keys(row))),
			].filter((key, at, all) => key !== 'problems' && all.indexOf(key) === at);
			described[name] = columns;
			db.run(`CREATE TABLE "${name}" (${columns.map((c) => `"${c}"`).join(', ')})`);
			const insert = db.prepare(
				`INSERT INTO "${name}" VALUES (${columns.map(() => '?').join(', ')})`,
			);
			db.transaction(() => {
				for (const row of rows)
					insert.run(
						...columns.map((column) => {
							const value = row[column];
							if (value === undefined || value === null) return null;
							if (typeof value === 'object') return JSON.stringify(value);
							if (typeof value === 'boolean') return value ? 1 : 0;
							return value as string | number;
						}),
					);
			})();
		}
		if (sql === undefined) return { tables: described };
		db.run('PRAGMA query_only = ON');
		// The tables hold only text, numbers, and nulls, so a result does too.
		type Cell = string | number | null;
		return { rows: db.query<Record<string, Cell>, []>(sql).all() };
	},
});

export default defineApp({
	description:
		'My writing: every page and journal entry, the collections that gather pages for an audience, and where each page has been posted',
	collections: { pages, journal, collections },
	actions: {
		pages: pages.actions(),
		journal: journal.actions(),
		collections: collections.actions(),
		record,
		check,
		query,
	},
});
```

`check` here covers fields and three rules across files. Today's `check` also
verifies narration packages, pointers between pages, and the conversation
hub's privacy; those port in phase 2.

### The draft `epicenter.test.ts`

Eight tests over `createMemoryContext`, all passing. This is the whole file:

```ts
/**
 * Verifies the vault's own actions: `record` completes or adds a post and is
 * safe to repeat, `check` names what does not fit, and `query` only reads.
 */
import { expect, test } from 'bun:test';
import { createMemoryContext, inRun, localDay } from '@epicenter/app';
import vault from './epicenter.ts';

const { record, check, query } = vault.actions;

const PAGE = 'data/pages/on-waiting.md';
const page = (lines: string[], body = 'The work.\n') =>
	`---\ntitle: "On waiting"\ndate: "2026-10-01"\ntimezone: "America/Los_Angeles"\n${lines.map((line) => `${line}\n`).join('')}---\n${body}`;

test('record fills the earliest planned post to the account and leaves the rest', async () => {
	const context = createMemoryContext({
		[PAGE]: page([
			'posts: [{"on": "2026-10-20", "to": "x/braden"}, {"on": "2026-10-14", "to": "x/braden"}, {"on": "2026-10-10", "to": "threads/braden"}]',
		]),
	});
	const answer = await inRun(context, () =>
		record({ page: 'on-waiting', account: 'x/braden', url: 'https://x.com/1' }),
	);
	expect(answer).toEqual({
		page: PAGE,
		account: 'x/braden',
		url: 'https://x.com/1',
		recorded: true,
	});
	expect(await context.folder.read(PAGE)).toBe(
		page([
			'posts: [{"on": "2026-10-20", "to": "x/braden"}, {"on": "2026-10-14", "to": "x/braden", "url": "https://x.com/1"}, {"on": "2026-10-10", "to": "threads/braden"}]',
		]),
	);
});

test('record adds a post dated today when none is planned, private without a link', async () => {
	const context = createMemoryContext({ [PAGE]: page([]) });
	await inRun(context, () => record({ page: 'on-waiting', account: 'bookface/braden' }));
	expect(await context.folder.read(PAGE)).toBe(
		page([
			`posts: [{"on": "${localDay()}", "to": "bookface/braden", "url": "private"}]`,
		]),
	);
});

test('record of a link already recorded changes nothing', async () => {
	const text = page([
		'posts: [{"on": "2026-10-14", "to": "x/braden", "url": "https://x.com/1"}, {"on": "2026-10-20", "to": "x/braden"}]',
	]);
	const context = createMemoryContext({ [PAGE]: text });
	const answer = await inRun(context, () =>
		record({ page: 'on-waiting', account: 'x/braden', url: 'https://x.com/1' }),
	);
	expect(answer.recorded).toBe(false);
	expect(await context.folder.read(PAGE)).toBe(text);
});

test('record reads a page written as YAML and keeps its body', async () => {
	const context = createMemoryContext({
		[PAGE]:
			'---\ntitle: On waiting\ndate: 2026-10-01\ntimezone: America/Los_Angeles\nposts:\n  - on: 2026-10-14\n    to: x/braden\n---\nThe work.\n',
	});
	await inRun(context, () =>
		record({ page: 'on-waiting', account: 'x/braden', url: 'https://x.com/1' }),
	);
	expect(await context.folder.read(PAGE)).toBe(
		page(['posts: [{"on": "2026-10-14", "to": "x/braden", "url": "https://x.com/1"}]']),
	);
});

test('record refuses a page that is not there, and a link that is not one', async () => {
	const context = createMemoryContext({ [PAGE]: page([]) });
	await expect(
		inRun(context, () => record({ page: 'missing', account: 'x/braden' })),
	).rejects.toMatchObject({ name: 'Missing' });
	await expect(
		inRun(context, () =>
			record({ page: 'on-waiting', account: 'x/braden', url: 'x.com/1' }),
		),
	).rejects.toThrow('A link starts with http:// or https://');
	expect(await context.folder.read(PAGE)).toBe(page([]));
});

test('check passes a folder where everything fits', async () => {
	const context = createMemoryContext({
		[PAGE]: page(['finishedAt: "2026-10-02"', 'slug: "on-waiting"', 'collections: ["essays"]']),
		'data/collections/essays.md':
			'---\ntitle: "Essays"\npace: "weekly"\naccounts: {"x/braden": {}}\n---\n',
		'data/journal/2026-10-01-a-walk.md':
			'---\ntitle: "A walk"\ndate: "2026-10-01"\ntimezone: "America/Los_Angeles"\n---\n',
	});
	expect(await inRun(context, () => check({}))).toEqual({ files: 3, issues: [] });
});

test('check names a slug without finishedAt, an unknown collection, a shared account, and a field that does not fit', async () => {
	const context = createMemoryContext({
		[PAGE]: page(['slug: "on-waiting"', 'collections: ["nowhere"]', 'resonance: 9']),
		'data/collections/essays.md': '---\ntitle: "Essays"\naccounts: {"x/braden": {}}\n---\n',
		'data/collections/notes.md': '---\ntitle: "Notes"\naccounts: {"x/braden": {}}\n---\n',
	});
	const { issues } = await inRun(context, () => check({}));
	expect(issues).toContain(`${PAGE}: slug requires finishedAt`);
	expect(issues).toContain(`${PAGE}: no collection nowhere`);
	expect(issues).toContain('x/braden: in both essays and notes');
	expect(issues.some((issue) => issue.startsWith(`${PAGE}: resonance`))).toBe(true);
	expect(issues).toHaveLength(4);
});

test('query answers SQL over the fields, with posts as JSON, and refuses a write', async () => {
	const context = createMemoryContext({
		[PAGE]: page([
			'finishedAt: "2026-10-02"',
			'posts: [{"on": "2026-10-14", "to": "x/braden"}, {"to": "x/braden", "url": "private"}]',
		]),
		'data/pages/a-draft.md': page([]),
	});
	expect(
		await inRun(context, () =>
			query({
				sql: "select page, json_extract(p.value, '$.on') as day from pages, json_each(pages.posts) p where json_extract(p.value, '$.url') is null",
			}),
		),
	).toEqual({ rows: [{ page: 'on-waiting', day: '2026-10-14' }] });
	expect(
		await inRun(context, () => query({ sql: 'select count(*) as n from pages where finishedAt is null' })),
	).toEqual({ rows: [{ n: 1 }] });
	await expect(
		inRun(context, () => query({ sql: 'delete from pages' })),
	).rejects.toThrow('readonly');
	expect(await inRun(context, () => query({}))).toMatchObject({
		tables: { pages: expect.arrayContaining(['path', 'page', 'title', 'posts']) },
	});
});
```

Both files also sit in the session's scratchpad, which a restart clears. This
spec is their durable copy until the app has a folder on the home.

## Where each command goes

Most of the vault's work is skills editing files, which needs no action
(rule 3: have the folder, write files). A command becomes an action only when
it carries a rule, reach, or a sign-in.

| Today (`bun run vault ...`) | Becomes | Phase |
| --- | --- | --- |
| `check` | `vault check` | 1, widened in 2 |
| `bun run epicenter query .` | `vault query` | 1 |
| `publish record` | `vault record` | 1 |
| `collections`, `tags inventory` | a `query`; delete the command | 1 |
| `page rename`, `account rename` | `vault rename-page`, `vault rename-account` | 2 |
| `sources rebuild` | `vault sources`, writing an ignored file under `data/` | 2 |
| `instagram preflight / publish / verify / connect / refresh`, `tiktok preflight` | `vault instagram ...`, `vault tiktok preflight` | 2 |
| `video make / direct / take / choose` | `vault video ...`, `make` and `take` yielding their progress (ADR-0879) | 3 |
| `clips describe / annotate` | `vault clips ...` | 3 |
| `calendar *` | the `calendar` app | 4 |
| `photos *` | the `photos` app | 4 |
| `paxo import / mark-reviewed` | the `recordings` app | 4 |
| `todoist materialize / export` | an intake pull beside `tasks` | 4 |
| `listen`, `search` | unchanged scripts | never |
| journal, page, and short-essay writing; finishing; planning | unchanged skills over files | never |

## Semantic shifts

Each of these changes what a file or a rule means. Grep for it before porting.

1. **`slug: null` no longer means "withheld".** In Epicenter `null` removes a
   field. Two pages and two collections carry `slug: null`, and
   `publishing/collections.ts` throws unless the conversation hub's slug is
   exactly `null`. The port reads "no slug" as withheld and deletes those four
   lines.
2. **The first write to a page rewrites its front matter.** Every value
   becomes one `key: <JSON>` line. Observed on one page:

   ```diff
   -date: 2023-09-01
   -timezone: America/New_York
   -collections:
   -  - yaps
   +date: "2023-09-01"
   +timezone: "America/New_York"
   +collections: ["yaps"]
   ```

   YAML reads both the same, so the blog's reader should not care, but that is
   unverified. Rewriting all 3,514 files in one commit, before anything else
   writes, keeps later diffs to the line that changed.
3. **The ignore file becomes the policy.** The vault's rule is "stage by path,
   never `git add .`", with `.gitignore` as a backstop. `serve` commits
   everything pending that Git does not ignore, within 5 minutes. A working
   take parked beside a page is committed unless a rule ignores it.
4. **`collections/README.md` reads as a collection** with no title. Move it
   up into the code repository's README.
5. **"Collection" now names two things:** the vault's audience noun and
   Epicenter's kind of file. The draft keeps the person's word, so the command
   is `epicenter vault collections list`. Inside `epicenter.ts` it reads
   `collections: { pages, journal, collections }`.
6. **Commits are named for calls.** A hand-written message such as "Draft
   three reflections from catching up" still works, through
   `epicenter sync vault -m`. Anything left longer than 5 minutes is committed
   as `vault: changed outside epicenter`.

Left alone on purpose: `resonance` is a number on pages and a word on journal
entries, and field names mix camelCase and snake_case. Neither blocks the
move, and renaming a field is a two-step change better made after it.

## Implementation plan

Each phase leaves the old command in `cli.ts` until its action passes the
matching cases from `cli.test.ts`, then deletes the command.

### Phase 1: the app reads the vault

Nothing moves yet. Steps 1.1 to 1.3 are done in a temporary home; see "Second
run" above for what each showed.

- [x] **1.1** In a temporary home, `epicenter new vault`, replace `data/` with
  a fresh clone of the vault's repository, and add `*.local` and `*.local.*`
  to its `.gitignore`. Confirm `epicenter vault check` and
  `epicenter history vault` work over the real history.
- [x] **1.2** Put the draft `epicenter.ts` in place with `typebox` and
  `@types/bun`. Add `epicenter.test.ts` over `createMemoryContext` for
  `record`, `check`, and `query`.
- [x] **1.3** Time `vault pages list` with the companion folders and media
  present: 0.33 s, and the walk of the real folder is 22 ms.
- [ ] **1.4** Put the app on the home, by the steps in "Step 1.4 in full"
  below. **Held by the owner on 2026-11-13**, after learning that the move
  changes the vault's Claude Code project. It needs a new go, and a moment
  when no agent is working in the vault. Steps 1.5 to 1.7 wait on it.
- [ ] **1.5** Point `vault-publishing` and `plan-pages` at
  `epicenter vault query`.
- [ ] **1.6** One commit rewriting every record's front matter (shift 2).
- [ ] **1.7** A `ui/`, copied from Tasks or Capture: find a page, read it, edit
  its body, add one. ADR-0897's month is use from a phone, and a phone reaches
  the home only through a UI at `/vault/`, so the month starts here, not at
  1.4.

### Step 1.4 in full

The home is the Mac Studio, where `~/Code/vault` already is and
`epicenter serve` already runs (port 4747, a login service). So this step is
a move on one computer, and `serve` acts on the vault from the moment
`epicenter.ts` is in place.

A symlink does not work. With `apps/vault/data` a symlink to a clone,
`vault check` answered `{ files: 0, issues: [] }` with no error. The
repository has to sit at `apps/vault/data` itself, and `~/Code/vault` becomes
the symlink.

Before:

- [ ] The laptop has pushed everything and stops using its clone. Checked
  2026-11-13: the remote's `main` (`700e30cf`) is contained in the home's
  `HEAD`, which is 7 commits ahead of it.
- [ ] No agent session is working in `~/Code/vault`. When this was written,
  13 processes had it as their working directory, one of them a Claude
  session.

The steps:

```sh
cd ~/Epicenter && epicenter new vault          # the code repository, with an empty data/
rm -rf apps/vault/data                         # the empty one, just made
mv ~/Code/vault apps/vault/data
ln -s ~/Epicenter/apps/vault/data ~/Code/vault # so ~/Code/vault still opens it
printf '\n*.local\n*.local.*\n' >> apps/vault/data/.gitignore
# copy epicenter.ts, epicenter.test.ts, tsconfig.json; add typebox, @types/bun, typescript
epicenter install vault && epicenter vault check
```

What changes the moment it is done:

- `serve` commits whatever is pending in the vault within 5 minutes, as
  `vault: changed outside epicenter`, and pushes to the vault's `origin`. The
  first push carries the 7 commits not yet pushed.
- An agent that wants its own commit message runs
  `epicenter sync vault -m "<what it did>"` or commits before the clock does.
  The vault's `AGENTS.md` needs that rule in place of "stage by path".
- Every action is an MCP tool for anything on the tailnet: `vault_record`,
  `vault_pages_set`, `vault_pages_delete`.

What depends on where the vault is, and breaks or needs a look after the move:

| What | Why |
| --- | --- |
| `.agents/skills/skills-and-instructions` | a relative link, `../../../epicenter/...`, which no longer resolves; the other 14 skill links are absolute |
| the blog's `tsconfig.json`, `"@vault/*": ["../vault/*"]` | resolves through the symlink for a path, but a tool that resolves the real path first lands in `~/Epicenter/apps/vault/` |
| `~/Library/LaunchAgents/com.braden.vault-liberalism-review.plist` | names `~/Code/vault` four times; works through the symlink |
| `package.json`'s `../worktrees/epicenter-stable` | already broken; delete in phase 2 |
| Claude Code's project for the vault, `~/.claude/projects/-Users-braden-Code-vault` (51 sessions, a `memory/` of 4 files) | Claude names a project by its real path: no project there starts `-tmp`, 193 start `-private-tmp`. A session started in `~/Code/vault` after the move belongs to `-Users-braden-Epicenter-apps-vault-data`, with no memory and none of those sessions to resume, unless `memory/` is copied across |
| Codex's `[projects."/Users/braden/Code/vault"]` in `~/.codex/config.toml` | its trust is by path; whether Codex resolves the symlink first was not checked |

Checked 2026-11-13 23:54: the vault was quiet. Both Codex sessions there had
ended their turns, the last at 22:35; no file had changed in 15 minutes; the
9 `node_repl` processes still in it are idle helpers of the Codex app, and
the tenth process is the LaunchAgent's own server. The installed `epicenter`
(0.0.2, which `serve` has run since 23:41) passes the same check, query, and
8 tests over a clone. The move was held anyway, for the Claude project row
above, which the owner had not been told about when approving it.

### The link the other way

The owner's lean, 2026-11-13: leave the vault at `~/Code/vault`, because the
Claude, Codex, and ChatGPT chats all point there, and link to it from
Epicenter.

Only one place in the runtime refuses that, and the rest already allows it:

| Where | What it does with a link |
| --- | --- |
| `packages/cli/src/home.ts:81` | an app's folder may itself be a link; the listing records its target |
| `packages/cli/src/data.ts:84` | the check that `data/` is the top of its own repository resolves links on both sides, so a linked `data` passes |
| `folderOnDisk`'s `read`, `write`, `update` (`disk.ts`) | join the path and follow links |
| `folderOnDisk`'s `list` (`disk.ts:199`) | answers an empty list when any part of the listed folder is a link |

So with `data` a link today, `get` and `set` work on a path and `list` says
there is nothing. The change is in `list`: accept a link at `data` itself and
keep refusing one beneath it, with a test. The app's code `.gitignore` then
names `data` without the trailing slash, which a link does not match.

This is not only the vault's need. Whispering's recordings sit in its own
data directory (ADR-0894), with the same choice between moving them and
linking to them. An earlier draft of this spec called the link an exception
the target shape does not need; that was wrong.

**Built 2026-11-14 on branch `claude/linked-data-folder`,** one commit, open
as https://github.com/EpicenterHQ/epicenter/pull/2603. A search of every
other place the CLI walks a folder or inspects a link found none that touch
an app's data. Trying it found two more places than `list`:

| File | Change |
| --- | --- |
| `packages/cli/src/disk.ts` | `list` follows a link at `data` itself, from the app's top or by name, and still no link beneath it |
| `packages/cli/src/snapshot.ts` | the code's commit checks `data` without the slash when `data` is a link. Before, Git answered "beyond a symbolic link" and the refusal told the person to add `data/`, which does not match a link |
| `packages/cli/src/epicenter-repository.ts` | `repositories.json` lists an app's linked `data` with its origin, so `init --from` clones it into `data/` on another computer. Before, the walk skipped it and the list left the data out |
| `packages/cli/README.md` | three sentences saying so |

The CLI's suite passes with three new tests (184), and the typecheck and
lint are clean. With a clone of the vault linked as `data` in a temporary
home: `check` reads 3,513 files, `pages list` 3,306 rows; `sync` refuses the
code until `.gitignore` lists `data`, then commits it without the link;
`record`, `history`, and `undo` work; a push is attempted through the link;
`serve` lists 21 MCP tools and answers `check` over HTTP.

With it installed, step 1.4 is:

```sh
cd ~/Epicenter && epicenter new vault
rm -rf apps/vault/data && ln -s ~/Code/vault apps/vault/data
printf 'data\nnode_modules/\n' > apps/vault/.gitignore
printf '\n*.local\n*.local.*\n' >> ~/Code/vault/.gitignore
# copy epicenter.ts, epicenter.test.ts, tsconfig.json; add typebox, @types/bun, typescript
epicenter install vault && epicenter vault check
```

Nothing that points at `~/Code/vault` changes, and undoing it is removing
`apps/vault`. It needs the branch merged, the `epicenter` binary rebuilt and
installed, and `serve` restarted, since `serve` runs the installed binary.
"What changes the moment it is done" above still holds: the 5-minute commits
and pushes, and the MCP tools.

To undo: remove the symlink, `mv` the repository back, and delete
`~/Epicenter/apps/vault`. Snapshot commits already pushed stay in history.

### Phase 2: publishing leaves `@epicenter/folder`

- [ ] **2.1** Move `publishing/` to `vault/lib/` and replace `rows.ts` with
  reads and writes through the three collections. `formatRow`, `parseRow`,
  `readFolder`, `folder.ts`, `epicenter.json`, and `kv.json` go.
  `canonicalOrigin` becomes a one-file collection, `data/settings.md`.
- [ ] **2.2** Port `rename-page`, `rename-account`, `sources`, and the rest of
  `check`.
- [ ] **2.3** Port Instagram and TikTok. A token is a `.local.md` one-file
  collection per account, unless open question 3 keeps Infisical.
- [ ] **2.4** Give the blog repository a way to read public pages that does
  not import the vault's code by relative path.

### Phase 3: video

- [ ] **3.1** `remotion/` moves into the code repository; its scripts read
  pages through the collections.
- [ ] **3.2** `video make` and `video take` become yielding actions. They need
  the clip drive, ffmpeg, and a browser on the home.

### Phase 4: the mirrors leave

- [ ] **4.1** `calendar`, `photos`, and `recordings` each become an app,
  copied from Mail's shape: a `pull`, a `status` that says when it last ran
  and how complete it is, and acts that change the source.
- [ ] **4.2** `recordings` waits on files beside a record (vision's Next 3).
- [ ] **4.3** Delete the dead folders in the table above.

## Open questions

1. **Decided 2026-11-13: home only.** The laptop keeps no clone of the vault
   and reaches it by `ssh` or `serve`. The month logs each time that hurt.
   The alternative, a laptop clone pulled into the home by hand, was refused
   because it hides what the month measures.
2. **Does the code's history move?** `git filter-repo` can carry
   `publishing/` and `remotion/` history into the code repository.
   - **Recommendation**: start the code repository fresh. The old history
     stays in the data repository, where it already is.
3. **Secrets in Infisical or in `.local` files?** ADR-0870 says `.local`.
   Instagram's `refresh` rotates tokens and writes them back, which a file on
   the home does more simply.
   - **Recommendation**: `.local`, once only the home runs these actions.
4. **Should `pages set` refuse a slug without `finishedAt`?** The generated
   `set` checks one field at a time.
   - **Recommendation**: leave it to `check`, as today. A hand edit skips an
     action anyway.
5. **Audio with one copy.** Most of Paxo's 8 GB of audio is ignored, with
   iCloud as its only other copy. Back it up before phase 4, whatever
   `recordings` decides about LFS.
6. **The repository is 8.46 GiB packed, for a 0.29 GiB checkout.** A local
   clone took 2.4 s, but a clone over the network was not tried, and
   `init --from` rebuilds an Epicenter by cloning each repository. Most of
   the weight is history of files since removed.
   - **Recommendation**: try one network clone before depending on
     `init --from`. Do not rewrite history to shrink it; ADR-0897 says the
     history does not move.
7. **`tasks/` in the vault.** Retire it into the `tasks` app, or keep daily
   checkbox files as the person's own?

## Adjacent work

- A `pull` and `status` convention shared by every cached collection (vision's
  Next 4). Phase 4 writes it three times; settle the answer's shape before the
  second.
- The vision's example `epicenter vault calendar show` should become
  `epicenter calendar show`.

## Success criteria

- [ ] `epicenter vault check` on the home reports no issue the old `check`
  would not.
- [ ] A page is read and edited from the phone through `serve`.
- [ ] `vault-publishing` and `plan-pages` answer what is due through
  `epicenter vault query`.
- [ ] `grep -r "@epicenter/folder"` in the vault's code finds nothing.
- [ ] `cli.ts` holds only `listen` and `search`, or is gone.

## References

- `docs/vision.md`, ADR-0896, ADR-0897, ADR-0898: the rules this follows.
- ADR-0876, ADR-0877: code at the top, records under `data/`, two repositories.
- `packages/app/src/front-matter.ts`: reads YAML, rewrites to `key: <JSON>` on
  the first write.
- `packages/app/src/collection.ts:720`: `list` reads every file.
- `~/Epicenter/apps/mail`: the shape for a cached source.
- `~/Code/vault/folder.ts`: the field declarations the draft was ported from.
- `~/Code/vault/publishing/page-model.ts:233`: `recordPagePost`, ported as
  `record`.
- `~/Code/vault/cli.test.ts`: the cases each ported action must pass.
