/**
 * Publication attempt contract: each table's formatted schema put over its
 * `<table>/.epicenter.json` as it was read, guarded by its hash. An awaited
 * put where no file is when the file is missing; a put guarded by the bytes
 * read, the schema replacing the file whole, when it holds other bytes; no
 * write when it holds the schema's bytes; no root `epicenter.json` and no
 * `local` in any file; another read when another writer got there first, up
 * to the write's attempts; and failure diagnostics retaining uncertain
 * outcomes.
 */
import { afterEach, expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { defineFolder, defineTable, field } from './contract.js';
import { formatDefinition } from './declaration.js';
import { FileError } from './errors.js';
import { hashBytes } from './hash.js';
import { events } from './publication-log.test-support.js';

afterEach(() => {
	events.length = 0;
});
const { publishDefinition } = await import('./publish-definition.js');

const definition = defineFolder({
	tables: { todos: defineTable({ fields: { title: field.string() } }) },
});
/** The one table's schema file. */
const SCHEMA = 'todos/.epicenter.json';
/** The text `definition` publishes at `SCHEMA`. */
const schema = formatDefinition(definition)[SCHEMA]!;
const encode = (text: string) => new TextEncoder().encode(text);
const missing = async (path: string) => FileError.NotFound({ path });
/** A file holding `text`. */
const holding = (text: string) => async () => {
	const bytes = encode(text);
	return Ok({ bytes, sha256: await hashBytes(bytes) });
};
const shaOf = (text: string) => hashBytes(encode(text));

/** Storage whose puts the test records; each read answers from `reads`. */
function recording(
	reads: readonly ((path: string) => Promise<unknown>)[],
	answer: () => Promise<unknown> = async () => Ok('landed'),
) {
	const writes: { text: string; ifMatch: string | null }[] = [];
	const paths: string[] = [];
	let read = 0;
	const storage = {
		read: (path: string) => reads[Math.min(read++, reads.length - 1)]!(path),
		put: async (
			path: string,
			bytes: Uint8Array | null,
			ifMatch: string | null,
		) => {
			paths.push(path);
			writes.push({
				text: new TextDecoder().decode(bytes ?? undefined),
				ifMatch,
			});
			return answer();
		},
	} as unknown as Parameters<typeof publishDefinition>[1];
	return { storage, writes, paths };
}

test('a missing declaration is created, and the attempt waits for the file outcome', async () => {
	const done = Promise.withResolvers<void>();
	const { storage, writes } = recording([missing], async () => {
		await done.promise;
		return Ok('landed');
	});
	let returned = false;
	const opening = publishDefinition(definition, storage).then(() => {
		returned = true;
	});
	while (writes.length === 0) await Bun.sleep(1);
	expect(writes).toEqual([{ text: schema, ifMatch: null }]);
	expect(returned).toBe(false);
	done.resolve();
	await opening;
	expect(returned).toBe(true);
});

test('a file already holding the schema bytes is not rewritten', async () => {
	const { storage, writes } = recording([holding(schema)]);
	await publishDefinition(definition, storage);
	expect(writes).toEqual([]);
	expect(events).toEqual([]);
});

test('the same JSON spelled otherwise is put over once, guarded by what was read, with nothing overridden', async () => {
	const there = schema.trimEnd();
	const { storage, writes } = recording([holding(there)]);
	await publishDefinition(definition, storage);
	expect(writes).toEqual([{ text: schema, ifMatch: await shaOf(there) }]);
	expect(events).toEqual([]);
});

test('the schema replaces the file it read whole, keys only the file held included', async () => {
	const titled = defineFolder({ title: 'Mine', tables: definition.tables });
	const there = '{"type":"object","properties":{},"note":"x"}\n';
	const { storage, writes, paths } = recording([holding(there)]);
	// The title is in no file: the schema is the table's alone.
	expect(await publishDefinition(titled, storage)).toBe(true);
	expect(paths).toEqual([SCHEMA]);
	expect(writes).toEqual([{ text: schema, ifMatch: await shaOf(there) }]);
	expect(events).toEqual([]);
});

test('each table publishes its own file, and one that fails stops neither the others nor the write', async () => {
	const two = defineFolder({
		tables: {
			todos: definition.tables.todos,
			notes: defineTable({ fields: { body: field.string() } }),
		},
	});
	const { storage, writes, paths } = recording([missing], async () =>
		paths.at(-1) === 'notes/.epicenter.json'
			? FileError.Unconfirmed({
					operation: 'create',
					path: 'notes/.epicenter.json',
					cause: 'lost',
				})
			: Ok('landed'),
	);
	await publishDefinition(two, storage);
	expect(paths).toEqual(['todos/.epicenter.json', 'notes/.epicenter.json']);
	expect(writes.map((write) => write.text)).toEqual(
		Object.values(formatDefinition(two)),
	);
	expect(events).toHaveLength(1);
	expect(events[0]?.data).toMatchObject({
		name: 'DefinitionPublicationUnconfirmed',
		path: 'notes/.epicenter.json',
	});
});

test('a newer definition that drops a table and a field and reopens a table rewrites its own tables alone', async () => {
	const v1 = defineFolder({
		tables: {
			todos: defineTable({
				fields: { title: field.string(), gone: field.string() },
				additionalProperties: false,
			}),
			old: defineTable({ fields: { x: field.string() } }),
		},
	});
	const v2 = defineFolder({
		tables: { todos: defineTable({ fields: { title: field.string() } }) },
	});
	const { storage, writes, paths } = recording([
		holding(formatDefinition(v1)[SCHEMA]!),
	]);
	await publishDefinition(v2, storage);
	// The dropped table's schema is not the newer definition's to remove.
	expect(paths).toEqual([SCHEMA]);
	expect(writes.map((write) => write.text)).toEqual([
		formatDefinition(v2)[SCHEMA]!,
	]);
});

test('a file another writer lands between the read and the put is read again and replaced, never merged', async () => {
	const first = schema.trimEnd();
	const landed = '{"type":"object","note":"landed meanwhile"}\n';
	let puts = 0;
	const { storage, writes } = recording(
		[holding(first), holding(landed)],
		async () => (puts++ === 0 ? Ok('stale') : Ok('landed')),
	);
	await publishDefinition(definition, storage);
	expect(writes).toEqual([
		{ text: schema, ifMatch: await shaOf(first) },
		{ text: schema, ifMatch: await shaOf(landed) },
	]);
	expect(events).toEqual([]);
});

test('another writer getting there first is read again, as many times as a write tries', async () => {
	const theirs = '{"type":"object"}\n';
	const { storage, writes } = recording([missing, holding(theirs)], async () =>
		Ok('stale'),
	);
	await publishDefinition(definition, storage);
	expect(writes.map((write) => write.ifMatch)).toEqual([
		null,
		await shaOf(theirs),
		await shaOf(theirs),
	]);
	expect(events).toHaveLength(1);
	expect(events[0]?.data).toMatchObject({
		name: 'DefinitionPublicationUnconfirmed',
		cause: { name: 'KeptChanging', attempts: 3 },
	});
});

for (const [name, read] of [
	[
		'a failed read',
		async (path: string) =>
			FileError.Unconfirmed({ operation: 'read', path, cause: 'lost' }),
	],
	[
		'a thrown read',
		async () => {
			throw new Error('read rejected');
		},
	],
] as const)
	test(`${name} writes nothing and is logged`, async () => {
		const { storage, writes } = recording([read]);
		await publishDefinition(definition, storage);
		expect(writes).toEqual([]);
		expect(events).toHaveLength(1);
	});

test('a lost write reply preserves Unconfirmed and its actual cause in the diagnostic', async () => {
	const lost = new Error('Lost native reply after sending create');
	const refusal = FileError.Unconfirmed({
		operation: 'create',
		path: SCHEMA,
		cause: lost,
	});
	const { storage } = recording([missing], async () => refusal);
	await publishDefinition(definition, storage);
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({
		source: 'folder/definition',
		level: 'error',
		data: {
			name: 'DefinitionPublicationUnconfirmed',
			path: SCHEMA,
			cause: { name: 'Io', cause: refusal.error },
		},
	});
});

test('a thrown write retains its cause without claiming whether the save landed', async () => {
	const cause = new Error('Connection closed after sending create');
	const { storage } = recording([missing], async () => {
		throw cause;
	});
	await publishDefinition(definition, storage);
	expect(events).toHaveLength(1);
	expect(events[0]?.data).toMatchObject({
		name: 'DefinitionPublicationUnconfirmed',
		path: SCHEMA,
		cause,
	});
});

test('a .gitignore that cannot be read writes nothing, names .gitignore in the log, and leaves the publication unconfirmed', async () => {
	const storage = {
		read: async (path: string) => FileError.NotAFile({ path }),
		put: async () => {
			throw new Error('nothing is written');
		},
	} as unknown as Parameters<typeof publishDefinition>[1];
	const local = defineFolder({ tables: {}, local: ['audio/'] });
	expect(await publishDefinition(local, storage)).toBe(false);
	expect(events).toHaveLength(1);
	expect(events[0]?.data).toMatchObject({
		name: 'LocalPatternsUnconfirmed',
		cause: { path: '.gitignore' },
	});
});
