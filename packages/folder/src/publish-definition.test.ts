/**
 * Publication attempt contract: the formatted definition put over the file
 * as it was read, guarded by its hash. An awaited put where no file is when the
 * file is missing; a put guarded by the bytes read, the definition replacing
 * the file whole, when it holds other bytes; `local` the union of the
 * file's patterns and the definition's; no write when it holds the
 * declaration's bytes; another read when another writer got there first, up
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
const { publishDefinition, publishLocalPatterns } = await import(
	'./publish-definition.js'
);

const definition = defineFolder({ tables: {} });
const encode = (text: string) => new TextEncoder().encode(text);
const missing = async (path: string) => FileError.NotFound({ path });
/** A file at `epicenter.json` holding `text`. */
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
	let read = 0;
	const storage = {
		read: (path: string) => reads[Math.min(read++, reads.length - 1)]!(path),
		put: async (
			path: string,
			bytes: Uint8Array | null,
			ifMatch: string | null,
		) => {
			expect(path).toBe('epicenter.json');
			writes.push({
				text: new TextDecoder().decode(bytes ?? undefined),
				ifMatch,
			});
			return answer();
		},
	} as unknown as Parameters<typeof publishDefinition>[1];
	return { storage, writes };
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
	expect(writes).toEqual([
		{ text: formatDefinition(definition), ifMatch: null },
	]);
	expect(returned).toBe(false);
	done.resolve();
	await opening;
	expect(returned).toBe(true);
});

test('a file already holding the declaration bytes is not rewritten', async () => {
	const { storage, writes } = recording([
		holding(formatDefinition(definition)),
	]);
	await publishDefinition(definition, storage);
	expect(writes).toEqual([]);
	expect(events).toEqual([]);
});

test('the same JSON spelled otherwise is put over once, guarded by what was read, with nothing overridden', async () => {
	const there = formatDefinition(definition).trimEnd();
	const { storage, writes } = recording([holding(there)]);
	await publishDefinition(definition, storage);
	expect(writes).toEqual([
		{ text: formatDefinition(definition), ifMatch: await shaOf(there) },
	]);
	expect(events).toEqual([]);
});

test('the definition replaces the file it read whole, keys only the file held included', async () => {
	const titled = defineFolder({ title: 'Mine', tables: {} });
	const there = '{"title":"Another app","note":"x"}\n';
	const { storage, writes } = recording([holding(there)]);
	await publishDefinition(titled, storage);
	expect(writes).toEqual([
		{ text: formatDefinition(titled), ifMatch: await shaOf(there) },
	]);
	expect(events).toEqual([]);
});

test('a newer definition that drops a table and a field and reopens a table is the whole file', async () => {
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
	const { storage, writes } = recording([holding(formatDefinition(v1))]);
	await publishDefinition(v2, storage);
	expect(writes.map((write) => write.text)).toEqual([formatDefinition(v2)]);
});

test("the published local is the sorted union of the file's patterns and the definition's", async () => {
	const own = defineFolder({ tables: {}, local: ['audio/'] });
	const theirs = defineFolder({ tables: {}, local: ['drafts/'] });
	const both = defineFolder({ tables: {}, local: ['audio/', 'drafts/'] });
	const { storage, writes } = recording([holding(formatDefinition(theirs))]);
	expect(await publishDefinition(own, storage)).toEqual(['audio/', 'drafts/']);
	expect(writes).toEqual([
		{
			text: formatDefinition(both),
			ifMatch: await shaOf(formatDefinition(theirs)),
		},
	]);
	// A file already listing them all, and this definition's, is left alone.
	const again = recording([holding(formatDefinition(both))]);
	await publishDefinition(own, again.storage);
	expect(again.writes).toEqual([]);
});

test('a file another writer lands between the read and the put is read again and replaced, never merged', async () => {
	const first = formatDefinition(definition).trimEnd();
	const landed = '{"tables":{},"note":"landed meanwhile"}\n';
	let puts = 0;
	const { storage, writes } = recording(
		[holding(first), holding(landed)],
		async () => (puts++ === 0 ? Ok('stale') : Ok('landed')),
	);
	await publishDefinition(definition, storage);
	expect(writes).toEqual([
		{ text: formatDefinition(definition), ifMatch: await shaOf(first) },
		{ text: formatDefinition(definition), ifMatch: await shaOf(landed) },
	]);
	expect(events).toEqual([]);
});

test('another writer getting there first is read again, as many times as a write tries', async () => {
	const theirs = '{"title":"Another app"}\n';
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
		path: 'epicenter.json',
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
			path: 'epicenter.json',
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
		path: 'epicenter.json',
		cause,
	});
});

test('a .gitignore that cannot be read writes nothing and names .gitignore in the log', async () => {
	const storage = {
		read: async (path: string) => FileError.NotAFile({ path }),
		put: async () => {
			throw new Error('nothing is written');
		},
	} as unknown as Parameters<typeof publishLocalPatterns>[1];
	await publishLocalPatterns(['audio/'], storage);
	expect(events).toHaveLength(1);
	expect(events[0]?.data).toMatchObject({
		name: 'LocalPatternsUnconfirmed',
		cause: { path: '.gitignore' },
	});
});
