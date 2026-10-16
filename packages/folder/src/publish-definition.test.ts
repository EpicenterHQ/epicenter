/**
 * Publication attempt contract: an awaited put where no file is when the
 * file is missing, a put guarded by the bytes read, never merged, when it
 * holds other bytes, no write when it holds the declaration's, every `local`
 * pattern the file lists kept, one more read when another writer got there
 * first, and failure diagnostics retaining uncertain outcomes.
 */
import { afterEach, expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { hashBytes } from './capture.js';
import { formatDeclaration } from './declaration.js';
import { defineFolder } from './definition.js';
import { FileError } from './errors.js';
import { events } from './publication-log.test-support.js';

afterEach(() => {
	events.length = 0;
});
const { publishDefinition } = await import('./publish-definition.js');

const definition = defineFolder({ kv: {}, tables: {} });
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
		{ text: formatDeclaration(definition), ifMatch: null },
	]);
	expect(returned).toBe(false);
	done.resolve();
	await opening;
	expect(returned).toBe(true);
});

test('a file already holding the declaration bytes is not rewritten', async () => {
	const { storage, writes } = recording([
		holding(formatDeclaration(definition)),
	]);
	await publishDefinition(definition, storage);
	expect(writes).toEqual([]);
	expect(events).toEqual([]);
});

for (const [name, there] of [
	['different bytes', '{"title":"Another app"}\n'],
	[
		'the same JSON without its trailing newline',
		formatDeclaration(definition).trimEnd(),
	],
] as const)
	test(`${name} are put over once, guarded by what was read, never merged`, async () => {
		const { storage, writes } = recording([holding(there)]);
		await publishDefinition(definition, storage);
		expect(writes).toEqual([
			{ text: formatDeclaration(definition), ifMatch: await shaOf(there) },
		]);
		expect(events).toEqual([]);
	});

test('a local pattern the file lists, from another device, is kept', async () => {
	const own = defineFolder({ kv: {}, tables: {}, local: ['audio/'] });
	const theirs = defineFolder({ kv: {}, tables: {}, local: ['drafts/'] });
	const both = defineFolder({
		kv: {},
		tables: {},
		local: ['audio/', 'drafts/'],
	});
	const { storage, writes } = recording([holding(formatDeclaration(theirs))]);
	await publishDefinition(own, storage);
	expect(writes).toEqual([
		{
			text: formatDeclaration(both),
			ifMatch: await shaOf(formatDeclaration(theirs)),
		},
	]);
	// A file already listing them all, and this definition's, is left alone.
	const again = recording([holding(formatDeclaration(both))]);
	await publishDefinition(own, again.storage);
	expect(again.writes).toEqual([]);
});

test('another writer getting there first is read once more', async () => {
	const theirs = '{"title":"Another app"}\n';
	const { storage, writes } = recording([missing, holding(theirs)], async () =>
		Ok('stale'),
	);
	await publishDefinition(definition, storage);
	expect(writes.map((write) => write.ifMatch)).toEqual([
		null,
		await shaOf(theirs),
	]);
	// Two reads at most: the second stale put is the last word.
	expect(events).toHaveLength(1);
	expect(events[0]?.data).toMatchObject({
		cause: 'another writer changed the file on every attempt',
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
			cause: refusal.error,
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
