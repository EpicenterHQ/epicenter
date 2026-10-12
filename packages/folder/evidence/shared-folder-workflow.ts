/**
 * Experiment: one ordinary directory shared by two applications and an agent.
 *
 * Two definitions with the same `todos` table name, but different declared
 * fields and different KV keys, are opened one after the other over one real
 * temporary directory through the directory entry. Neither names the folder:
 * the directory entry is given its root.
 * An "agent" is plain `node:fs` writes into the same directory: it never goes
 * through a folder handle.
 *
 * Every claim is an assertion against bytes read back from disk with
 * `node:fs`, never against the handle that wrote them. The process exits
 * nonzero when any assertion fails.
 *
 * This establishes shared-file semantics for a directory only. It says
 * nothing about browser storage, the desktop owner, or sync between devices.
 *
 *   bun packages/folder/evidence/shared-folder-workflow.ts
 */
import { existsSync } from 'node:fs';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
	defineFolder,
	defineTable,
	type FolderDefinition,
	field,
	formatRow,
	hashBytes,
	openFolder,
	parseRow,
} from '@epicenter/folder/bun';
import type { Result } from 'wellcrafted/result';

// Keep the developer's global Git configuration (hooks, signing) out of the
// repository the opener initializes. This changes this process's environment
// only; no configuration file is read or written.
Object.assign(process.env, {
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_TERMINAL_PROMPT: '0',
});

// ---------------------------------------------------------------------------
// The two applications
// ---------------------------------------------------------------------------

/** App A: a checklist. It knows `title` and `done`. */
const appA = defineFolder({
	kv: {
		theme: field.string(),
		sortBy: field.string(),
		pageSize: field.number(),
	},
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});
const A_KV_DEFAULTS = { theme: 'light', sortBy: 'created', pageSize: 20 };

/** App B: a planner. It knows `title` and `priority`, and nothing of `done`. */
const appB = defineFolder({
	// `pageSize` is declared by both, with different types: a deliberate collision.
	kv: {
		density: field.string(),
		showArchived: field.boolean(),
		pageSize: field.string(),
	},
	tables: {
		todos: defineTable({
			fields: { title: field.string(), priority: field.number() },
		}),
	},
});
const B_KV_DEFAULTS = {
	density: 'comfortable',
	showArchived: false,
	pageSize: 'all',
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

let passed = 0;
const failures: string[] = [];

function section(title: string) {
	console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

function note(text: string) {
	console.log(`  · ${text}`);
}

/** Show exact text: escapes make line endings, a BOM, and trailing spaces visible. */
function show(label: string, text: string) {
	console.log(`  ${label}:`);
	for (const line of text.split(/(?<=\n)/))
		console.log(`    │ ${JSON.stringify(line).slice(1, -1)}`);
}

function check(label: string, condition: boolean, detail?: unknown) {
	if (condition) {
		passed += 1;
		console.log(`  ✓ ${label}`);
		return;
	}
	failures.push(label);
	console.log(`  ✗ ${label}`);
	if (detail !== undefined) console.log(`      got: ${JSON.stringify(detail)}`);
}

function ok<T, E>({ data, error }: Result<T, E>): T {
	if (error !== null)
		throw new Error(`Expected Ok, got ${JSON.stringify(error)}`);
	return data as T;
}

function refusal<T, E>({ data, error }: Result<T, E>): E {
	if (error === null)
		throw new Error(`Expected a refusal, got ${JSON.stringify(data)}`);
	return error;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const author = { name: 'Experiment', email: 'experiment@example.test' };
const encoder = new TextEncoder();
const PREFIX = 'epicenter-shared-folder-workflow-';
const root = await realpath(await mkdtemp(join(tmpdir(), PREFIX)));

/** Open the shared directory as one application. Every save commits; commits are not part of this experiment. */
async function open<const TDefinition extends FolderDefinition>(
	definition: TDefinition,
) {
	return ok(
		await openFolder({
			root,
			definition,
			git: { author },
		}),
	);
}

/** The agent's and the assertions' view: the directory through `node:fs`, never through a handle. */
const disk = {
	bytes: (path: string) => readFile(join(root, path)),
	text: async (path: string) =>
		(await readFile(join(root, path))).toString('utf8'),
	exists: (path: string) => existsSync(join(root, path)),
	write: (path: string, content: string | Uint8Array) =>
		writeFile(join(root, path), content),
};

try {
	console.log(`Disposable directory: ${root}`);
	console.log(`Bun ${Bun.version}, ${process.platform}`);

	// -------------------------------------------------------------------------
	// -------------------------------------------------------------------------
	section('1. App A creates a row with title, done, and a body');
	// -------------------------------------------------------------------------
	const ROW = 'todos/milk.md';
	const BODY = 'Whole milk, 2 litres.\n\nAsk about the *oat* one too.\n';
	{
		const a = await open(appA);
		const created = ok(
			await a.tables.todos.create(
				{ fields: { title: 'Buy milk', done: false }, body: BODY },
				{ stem: 'milk' },
			),
		);
		await a.close();
		const onDisk = await disk.text(ROW);
		show(ROW, onDisk);
		check(
			'the row is one ordinary Markdown file at todos/milk.md',
			disk.exists(ROW) && created.path === ROW,
		);
		check(
			'the returned row formats to exactly the bytes on disk',
			ok(formatRow(appA.tables.todos, created.row)) === onDisk,
		);
		check(
			'the returned hash is the hash of the bytes on disk',
			created.sha256 === (await hashBytes(await disk.bytes(ROW))),
		);
	}

	// -------------------------------------------------------------------------
	section('2. An agent edits the same file with a text editor');
	// -------------------------------------------------------------------------
	// A comment, a key neither application declares, and a quoting style the
	// folder would not have chosen itself.
	const AGENT_ROW =
		'---\n' +
		'# agent: reviewed 2026-10-02, do not reorder\n' +
		"title: 'Buy milk'   # quoted by hand\n" +
		'done: false\n' +
		'estimate: 15m\n' +
		'---\n' +
		BODY;
	await disk.write(ROW, AGENT_ROW);
	show(ROW, AGENT_ROW);
	note('written with node:fs; no folder handle is open');

	// -------------------------------------------------------------------------
	section('3. App B reads a row that lacks its own field');
	// -------------------------------------------------------------------------
	{
		const b = await open(appB);
		const listed = ok(await b.tables.todos.list());
		check(
			'B discovers the row A created by listing',
			listed.length === 1 && listed[0]?.stem === 'milk',
		);
		const { error: invalid } = await b.tables.todos.get('milk');
		check(
			"B's missing field makes the row InvalidRow for B, with one issue naming priority",
			invalid?.name === 'InvalidRow' &&
				invalid.issues.length === 1 &&
				invalid.issues[0].field === 'priority',
			invalid,
		);
		check(
			'B still has the exact text, comment and unknown keys included',
			invalid?.name === 'InvalidRow' && invalid.text === AGENT_ROW,
		);
		check(
			'the InvalidRow hash is the hash of the bytes on disk',
			invalid?.name === 'InvalidRow' &&
				invalid.sha256 === (await hashBytes(await disk.bytes(ROW))),
		);
		await b.close();
		check(
			'reading changed nothing on disk',
			(await disk.text(ROW)) === AGENT_ROW,
		);
	}

	// -------------------------------------------------------------------------
	section('4. App A reads again and ticks the checkbox');
	// -------------------------------------------------------------------------
	{
		const a = await open(appA);
		const stored = ok(await a.tables.todos.get('milk'));
		if (stored === undefined) throw new Error('A did not find the row');
		check(
			"A reads its own two fields from the agent's text",
			stored.row.fields.title === 'Buy milk' &&
				stored.row.fields.done === false,
			stored.row.fields,
		);
		check(
			'the key neither application declares stays on fields',
			(stored.row.fields as Record<string, unknown>).estimate === '15m',
			stored.row.fields,
		);
		check('A reads the same body it wrote', stored.row.body === BODY);

		stored.row.fields.done = true;
		const ticked = ok(await a.tables.todos.replace(stored, stored.row));
		await a.close();
		const after = await disk.text(ROW);
		show(ROW, after);
		check(
			'the guarded replace saved the canonical text of the edited row',
			after === ok(formatRow(appA.tables.todos, ticked.row)) &&
				ticked.sha256 === (await hashBytes(await disk.bytes(ROW))),
		);
		check(
			'the canonical save kept the unknown key and the body',
			after.includes('estimate: "15m"\n') && after.endsWith(`---\n${BODY}`),
		);
	}

	// -------------------------------------------------------------------------
	section('5. kv.json is absent until an application sets a key');
	// -------------------------------------------------------------------------
	{
		const a = await open(appA);
		const reading = ok(await a.kv.get());
		const effective = { ...A_KV_DEFAULTS, ...(reading?.values ?? {}) };
		check(
			'get() on a folder with no kv.json is Ok(undefined)',
			reading === undefined,
		);
		check(
			"A's effective settings are entirely its own defaults",
			JSON.stringify(effective) === JSON.stringify(A_KV_DEFAULTS),
			effective,
		);
		await a.close();
		check(
			'reading, defaulting, and closing left no kv.json',
			!disk.exists('kv.json'),
		);

		const b = await open(appB);
		check(
			'opening as B leaves it absent too',
			ok(await b.kv.get()) === undefined && !disk.exists('kv.json'),
		);
		await b.close();
	}
	{
		const a = await open(appA);
		const created = ok(await a.kv.set('theme', 'dark'));
		const onDisk = await disk.text('kv.json');
		show('kv.json', onDisk);
		check(
			'set() created the file with only the supplied key: the file is sparse, defaults are not saved',
			onDisk === '{\n  "theme": "dark"\n}\n' &&
				created.sha256 === (await hashBytes(await disk.bytes('kv.json'))),
		);
		await a.close();
	}

	// -------------------------------------------------------------------------
	section('6. Divergent KV schemas set only their own keys');
	// -------------------------------------------------------------------------
	// The agent adds a key neither application declares, with a number
	// spelling and spacing a serializer would not reproduce.
	const AGENT_KV = '{\n  "theme": "dark",\n\t"agentBudget":   1.50\n}\n';
	await disk.write('kv.json', AGENT_KV);
	show('kv.json after the agent', AGENT_KV);
	{
		const b = await open(appB);
		const reading = ok(await b.kv.get());
		check(
			"B reads none of A's keys or the agent's: values is empty, with no issues",
			reading !== undefined &&
				Object.keys(reading.values).length === 0 &&
				reading.issues.length === 0,
			reading?.values,
		);
		const effective = { ...B_KV_DEFAULTS, ...(reading?.values ?? {}) };
		check(
			"B's effective settings are its own defaults",
			JSON.stringify(effective) === JSON.stringify(B_KV_DEFAULTS),
			effective,
		);

		const undeclared = refusal(
			// @ts-expect-error `theme` is not a key of B's KV.
			await b.kv.set('theme', 'light'),
		);
		check(
			"B cannot set A's key: InvalidValues, nothing written",
			undeclared.name === 'InvalidValues' &&
				(await disk.text('kv.json')) === AGENT_KV,
			undeclared.name,
		);

		ok(await b.kv.set('density', 'compact'));
		await b.close();
		const onDisk = await disk.text('kv.json');
		show("kv.json after B's set", onDisk);
		check(
			"B's set wrote the merge format: keys sorted, two-space indentation, and A's and the agent's values as their own text",
			onDisk ===
				'{\n  "agentBudget": 1.50,\n  "density": "compact",\n  "theme": "dark"\n}\n',
		);
	}
	{
		const a = await open(appA);
		const before = await disk.text('kv.json');
		const reading = ok(await a.kv.get());
		check(
			"A reads only its own stored key; B's density is not in values",
			JSON.stringify(reading?.values) === '{"theme":"dark"}',
			reading?.values,
		);
		ok(await a.kv.set('theme', 'light'));
		await a.close();
		const after = await disk.text('kv.json');
		show("kv.json after A's set", after);
		check(
			"A's set changed only the value of theme",
			after === before.replace('"dark"', '"light"') && after !== before,
		);
		check(
			"the agent's number spelling survived both sets",
			after.includes('"agentBudget": 1.50'),
		);
	}

	// -------------------------------------------------------------------------
	section('6b. A key both applications declare, with different types');
	// -------------------------------------------------------------------------
	{
		const a = await open(appA);
		ok(await a.kv.set('pageSize', 50));
		await a.close();
		const before = await disk.text('kv.json');

		const b = await open(appB);
		const reading = ok(await b.kv.get());
		check(
			"A's number under a key B declares as a string is a field issue for B, and is left out of B's values",
			reading !== undefined &&
				!('pageSize' in reading.values) &&
				reading.issues.length === 1 &&
				reading.issues[0]?.field === 'pageSize',
			reading?.issues,
		);
		const effective = { ...B_KV_DEFAULTS, ...(reading?.values ?? {}) };
		check(
			'B falls back to its own default for that key',
			effective.pageSize === 'all',
			effective,
		);
		check(
			'reading it changed nothing on disk',
			(await disk.text('kv.json')) === before,
		);
		note(`B's issue: ${reading?.issues[0]?.message}`);

		ok(await b.kv.set('pageSize', 'all'));
		await b.close();
		const a2 = await open(appA);
		const forA = ok(await a2.kv.get());
		await a2.close();
		check(
			"nothing stops B from saving its own type there: A's stored value is gone and A now has the issue",
			forA !== undefined &&
				!('pageSize' in forA.values) &&
				forA.issues[0]?.field === 'pageSize',
			forA?.issues,
		);
	}

	// -------------------------------------------------------------------------
	section('6c. An agent leaves kv.json as text that is not strict JSON');
	// -------------------------------------------------------------------------
	{
		const good = await disk.text('kv.json');
		// A trailing comma: what a hand edit most often leaves behind.
		const BROKEN = good.replace('\n}\n', ',\n}\n');
		await disk.write('kv.json', BROKEN);
		show('kv.json', BROKEN);

		const a = await open(appA);
		const invalid = refusal(await a.kv.get());
		if (invalid.name !== 'InvalidKv')
			throw new Error(`Expected InvalidKv, got ${invalid.name}`);
		check(
			'get() is InvalidKv with the exact text and at least one issue',
			invalid.text === BROKEN && invalid.issues.length > 0,
			invalid.issues,
		);
		note(`issue: ${invalid.issues[0]?.message}`);
		const refused = refusal(await a.kv.set('theme', 'dark'));
		check(
			'set() is refused as InvalidKv and writes nothing',
			refused.name === 'InvalidKv' && (await disk.text('kv.json')) === BROKEN,
			refused.name,
		);

		// KV has no replace of its own: repair goes through files, then get.
		const capture = ok(await a.files.replace(invalid, good));
		const repaired = ok(await a.kv.get());
		await a.close();
		check(
			'files.replace(invalidKv, text) repairs it; the receipt is a bare capture of the bytes on disk',
			(await disk.text('kv.json')) === good &&
				capture.sha256 === (await hashBytes(await disk.bytes('kv.json'))) &&
				Object.keys(capture).sort().join() === 'path,sha256',
			Object.keys(capture),
		);
		check(
			"get() after the repair reads A's theme again",
			repaired?.values.theme === 'light',
			repaired?.values,
		);
	}

	// -------------------------------------------------------------------------
	section('7. An agent writes a value a declared field does not accept');
	// -------------------------------------------------------------------------
	const INVALID_FIELD =
		'---\ntitle: Buy milk\ndone: maybe\npriority: 2\n---\n' + BODY;
	await disk.write(ROW, INVALID_FIELD);
	show(ROW, INVALID_FIELD);
	{
		const a = await open(appA);
		const { error: invalid } = await a.tables.todos.get('milk');
		if (invalid?.name !== 'InvalidRow')
			throw new Error(`Expected InvalidRow, got ${JSON.stringify(invalid)}`);
		check(
			'the read is InvalidRow with the exact text',
			invalid.text === INVALID_FIELD,
		);
		check(
			'the invalid field is named by one issue, at its line',
			invalid.issues.length === 1 &&
				invalid.issues[0].field === 'done' &&
				invalid.issues[0].line === 3,
			invalid.issues,
		);
		note(`issue: ${invalid.issues[0].message}`);

		// InvalidRow carries the text, not fields: the repair is a complete row
		// built from what A knows, guarded by the bytes the read saw.
		note(
			"the repair below is a complete row of A's own fields; priority is not in it",
		);
		const repaired = ok(
			await a.tables.todos.replace(invalid, {
				fields: { title: 'Buy milk', done: false },
				body: BODY,
			}),
		);
		const reread = ok(await a.tables.todos.get('milk'));
		await a.close();
		check(
			'a guarded replace of a complete row repairs it, and the row reads back valid',
			(await disk.text(ROW)) ===
				ok(formatRow(appA.tables.todos, repaired.row)) &&
				reread?.row.fields.done === false &&
				reread.sha256 === repaired.sha256,
		);
	}

	// -------------------------------------------------------------------------
	section('8. An agent writes YAML that does not parse');
	// -------------------------------------------------------------------------
	const MALFORMED = '---\ntitle: [Buy milk\ndone: false\n---\n' + BODY;
	await disk.write(ROW, MALFORMED);
	show(ROW, MALFORMED);
	{
		const a = await open(appA);
		const listed = ok(await a.tables.todos.list());
		check(
			'the row is still listed, as an InvalidRow item',
			listed.length === 1 && listed[0]?.result.error?.name === 'InvalidRow',
		);
		const { error: invalid } = await a.tables.todos.get('milk');
		if (invalid?.name !== 'InvalidRow')
			throw new Error(`Expected InvalidRow, got ${JSON.stringify(invalid)}`);
		check(
			'get() is InvalidRow with the exact text and one issue',
			invalid.text === MALFORMED && invalid.issues.length === 1,
			invalid.issues,
		);
		note(`issue: ${invalid.issues[0].message}`);

		// Repair: complete replacement text, guarded by the invalid read's hash.
		const REPAIRED = MALFORMED.replace('[Buy milk', 'Buy milk');
		check(
			'parseRow() says the candidate repair is a valid row, before anything is saved',
			parseRow(appA.tables.todos, REPAIRED).error === null,
		);
		const capture = ok(await a.files.replace(invalid, REPAIRED));
		const reread = ok(await a.tables.todos.get('milk'));
		await a.close();
		check(
			'files.replace(invalid, text) saves the exact text, and the table reads it back as the row',
			(await disk.text(ROW)) === REPAIRED &&
				capture.sha256 === reread?.sha256 &&
				reread.row.fields.title === 'Buy milk' &&
				reread.row.body === BODY,
		);
	}

	// -------------------------------------------------------------------------
	section('9. An agent writes Markdown with no fences at all');
	// -------------------------------------------------------------------------
	const UNFENCED = '# Buy milk\n\nJust a note an agent dropped in.\n';
	await disk.write(ROW, UNFENCED);
	show(ROW, UNFENCED);
	{
		const b = await open(appB);
		const { error: invalid } = await b.tables.todos.get('milk');
		if (invalid?.name !== 'InvalidRow')
			throw new Error(`Expected InvalidRow, got ${JSON.stringify(invalid)}`);
		check('get() is InvalidRow with the exact text', invalid.text === UNFENCED);
		check(
			'the text is not read as a body, and nothing inserted fences',
			(await disk.text(ROW)) === UNFENCED,
		);
		note(`issue: ${invalid.issues[0].message}`);

		// Repair, keeping the agent's text as the body.
		const repaired = ok(
			await b.tables.todos.replace(invalid, {
				fields: { title: 'Buy milk', priority: 2 },
				body: UNFENCED,
			}),
		);
		await b.close();
		const onDisk = await disk.text(ROW);
		show(ROW, onDisk);
		check(
			"a guarded replace repairs it and keeps the agent's text as the body",
			onDisk === ok(formatRow(appB.tables.todos, repaired.row)) &&
				repaired.row.body === UNFENCED,
		);
		check(
			"B's repair did not write A's field, so A will see an issue for done",
			!onDisk.includes('done'),
		);
	}
	{
		const a = await open(appA);
		const { error: invalid } = await a.tables.todos.get('milk');
		if (invalid?.name !== 'InvalidRow')
			throw new Error(`Expected InvalidRow, got ${JSON.stringify(invalid)}`);
		ok(
			await a.tables.todos.replace(invalid, {
				fields: { title: 'Buy milk', done: false },
				body: UNFENCED,
			}),
		);
		await a.close();
		check(
			"A sees its field missing after B's repair, and restores it with one guarded replace",
			invalid.issues[0].field === 'done' &&
				(await disk.text(ROW)).includes('done: false\n'),
			invalid.issues,
		);
	}

	// -------------------------------------------------------------------------
	section('10. A stale capture: the agent edits between read and save');
	// -------------------------------------------------------------------------
	{
		const a = await open(appA);
		let hints = 0;
		const stop = a.onFilesChanged(() => {
			hints += 1;
		});
		const captured = ok(await a.tables.todos.get('milk'));
		if (captured === undefined) throw new Error('A did not find the row');
		const baseline = await disk.text(ROW);

		// The person in app A edits the title in a copy of the row.
		const candidate = {
			fields: { ...captured.row.fields, title: 'Buy milk and eggs' },
			body: captured.row.body,
		};

		// Meanwhile the agent appends a line to the body on disk.
		const agentText = `${baseline}\nAgent: the shop closes at 18:00.\n`;
		await disk.write(ROW, agentText);
		check(
			"the directory handle heard no hint for the agent's write",
			hints === 0,
			hints,
		);

		const refused = refusal(await a.tables.todos.replace(captured, candidate));
		stop();
		check(
			'the stale replacement is refused as Conflict',
			refused.name === 'Conflict',
			refused.name,
		);
		if (refused.name !== 'Conflict') throw new Error('Expected Conflict');
		const diskBytes = await disk.bytes(ROW);
		check(
			"nothing was written and nothing was retried: disk is exactly the agent's text",
			diskBytes.toString('utf8') === agentText,
		);
		check(
			'the conflict names the captured hash it expected',
			refused.expectedSha256 === captured.sha256,
		);
		check(
			'the conflict names the hash of what is on disk now',
			refused.actualSha256 === (await hashBytes(diskBytes)),
		);
		check(
			'the captured read is unchanged and still holds the baseline',
			captured.row.fields.title === 'Buy milk' && Object.isFrozen(captured),
		);

		// The conflict carries hashes, not text: disk text takes one more read.
		const current = ok(await a.tables.todos.get('milk'));
		if (current === undefined) throw new Error('A did not find the row');
		check(
			'one more get() reads the agent text, and its hash is the one the conflict named',
			current.row.body.includes('Agent: the shop closes') &&
				current.sha256 === refused.actualSha256,
		);
		const candidateText = ok(formatRow(appA.tables.todos, candidate));
		check(
			'all three texts are in hand and distinct: baseline, candidate, and disk',
			new Set([baseline, candidateText, agentText]).size === 3,
		);
		show('candidate (unsaved)', candidateText);
		show('disk (agent)', agentText);

		// What the application does next is its own decision. Here: redo the
		// one-field change on the current row and save it guarded by that read.
		current.row.fields.title = 'Buy milk and eggs';
		const merged = ok(await a.tables.todos.replace(current, current.row));
		await a.close();
		const onDisk = await disk.text(ROW);
		check(
			"redoing the change on the current row keeps the agent's line and lands the title",
			onDisk === ok(formatRow(appA.tables.todos, merged.row)) &&
				onDisk.includes('Agent: the shop closes') &&
				onDisk.includes('title: Buy milk and eggs\n'),
		);
	}

	// -------------------------------------------------------------------------
	section('11. Newlines and Unicode: saved bytes and the row read back');
	// -------------------------------------------------------------------------
	{
		const a = await open(appA);
		// A byte-order mark, CRLF line endings, a decomposed é (e + U+0301)
		// beside a precomposed one, an emoji outside the BMP, and no final newline.
		const EXACT =
			'﻿---\r\ntitle: "Cafe\u0301 vs Caf\u00e9 \u{1F95B}"\r\ndone: false\r\n---\r\nLigne un\r\nLigne deux';
		const snapshot = ok(await a.tables.todos.get('milk'));
		if (snapshot === undefined) throw new Error('A did not find the row');
		const capture = ok(await a.files.replace(snapshot, EXACT));
		const diskBytes = await disk.bytes(ROW);
		show(ROW, diskBytes.toString('utf8'));
		check(
			'the bytes on disk are the UTF-8 encoding of the submitted string',
			Buffer.compare(diskBytes, Buffer.from(encoder.encode(EXACT))) === 0,
		);
		check(
			'the returned hash is the hash of the bytes on disk',
			capture.sha256 === (await hashBytes(diskBytes)),
		);
		const reread = ok(await a.tables.todos.get('milk'));
		if (reread === undefined) throw new Error('A did not find the row');
		check(
			'nothing normalized the decomposed é into the precomposed one',
			reread.row.fields.title === 'Cafe\u0301 vs Caf\u00e9 \u{1F95B}' &&
				reread.row.fields.title !== reread.row.fields.title.normalize('NFC'),
		);
		check(
			'the body keeps CRLF and has no newline added at the end',
			reread.row.body === 'Ligne un\r\nLigne deux',
		);

		// A string that is not valid UTF-16 has no exact form in a file.
		const lone = refusal(
			await a.tables.todos.replace(reread, {
				fields: { title: 'lone \uD800 surrogate', done: false },
				body: '',
			}),
		);
		await a.close();
		check(
			'a row with an unpaired surrogate is refused as InvalidValues and nothing is written',
			lone.name === 'InvalidValues' &&
				Buffer.compare(await disk.bytes(ROW), diskBytes) === 0,
			lone.name,
		);
	}

	// -------------------------------------------------------------------------
	section('12. Files with unusual literal names that already exist');
	// -------------------------------------------------------------------------
	{
		// The agent creates these directly; no folder method chose the names.
		const names = ['.hidden', 'trailing ', ''];
		for (const stem of names)
			await disk.write(
				`todos/${stem}.md`,
				`---\ntitle: "stem=[${stem}]"\ndone: false\n---\n`,
			);
		// Not rows: the wrong case of extension, and a nested file.
		await disk.write('todos/shout.MD', '---\ntitle: not a row\n---\n');
		await mkdir(join(root, 'todos/nested'));
		await disk.write('todos/nested/deep.md', '---\ntitle: not a row\n---\n');
		note(
			`readdir(todos) = ${JSON.stringify((await readdir(join(root, 'todos'))).sort())}`,
		);

		const a = await open(appA);
		const listed = ok(await a.tables.todos.list());
		const stems = listed
			.map(({ stem, result }) => (result.error === null ? stem : '<error>'))
			.sort();
		check(
			'list() discovers the leading-dot, trailing-space, and empty-stem rows beside milk',
			JSON.stringify(stems) ===
				JSON.stringify(['', '.hidden', 'milk', 'trailing '].sort()),
			stems,
		);
		check(
			'shout.MD and nested/deep.md are not rows',
			!listed.some(
				(item) => item.stem.includes('shout') || item.stem.includes('nested'),
			),
		);
		for (const stem of names) {
			const row = ok(await a.tables.todos.get(stem));
			if (row === undefined) throw new Error(`A did not find ${stem}`);
			const saved = ok(
				await a.tables.todos.replace(row, {
					fields: { ...row.row.fields, done: true },
					body: row.row.body,
				}),
			);
			check(
				`stem ${JSON.stringify(stem)}: get() finds it at ${JSON.stringify(`todos/${stem}.md`)} and replace() saves it there`,
				row.path === `todos/${stem}.md` &&
					row.row.fields.title === `stem=[${stem}]` &&
					saved.path === row.path &&
					(await disk.text(`todos/${stem}.md`)).includes('done: true\n'),
			);
		}
		const files = ok(await a.files.list());
		await a.close();
		const inventory = files.files.map((file) => file.path);
		check(
			'files.list() inventories every one of them, rows or not, at its literal path',
			[
				'todos/.hidden.md',
				'todos/trailing .md',
				'todos/.md',
				'todos/shout.MD',
				'todos/nested/deep.md',
				'kv.json',
			].every((path) => inventory.includes(path)),
			inventory,
		);
	}

	// -------------------------------------------------------------------------
	section('What is in the directory at the end');
	// -------------------------------------------------------------------------
	for (const entry of (await readdir(root, { recursive: true })).sort())
		if (!entry.startsWith('.git')) console.log(`  ${JSON.stringify(entry)}`);
	check(
		'opening the directory initialized a Git repository in it, though this run asked for none',
		disk.exists('.git'),
	);
	const commits = Bun.spawnSync([
		'git',
		'-C',
		root,
		'rev-list',
		'--all',
		'--count',
	]);
	check(
		'saves made commits on their own',
		Number(commits.stdout.toString().trim()) > 0,
		commits.stdout.toString() + commits.stderr.toString(),
	);
} finally {
	// Only the directory this run made: under the system temp directory, with this run's prefix.
	const base = await realpath(tmpdir());
	if (root.startsWith(`${base}${sep}${PREFIX}`))
		await rm(root, { recursive: true, force: true });
	console.log(`\nRemoved ${root}: ${!existsSync(root)}`);
}

section('Result');
console.log(`  ${passed} assertions passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  ✗ ${failure}`);
if (failures.length > 0) process.exit(1);
