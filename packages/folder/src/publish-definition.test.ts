/**
 * Publication attempt contract: an awaited create when the file is missing,
 * a save that never merges when it holds other bytes, no write when it holds
 * the declaration's, every `local` pattern the file lists kept, one more read when another writer got there first, and
 * failure diagnostics retaining uncertain outcomes.
 */
import { afterEach, expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { fileCapture, hashBytes } from './capture.js';
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
const holding = (text: string) => async (path: string) => {
	const bytes = encode(text);
	return Ok({ ...fileCapture(path, await hashBytes(bytes)), bytes });
};

/** Files whose writes the test records; each read answers from `reads`. */
function recording(
	reads: readonly ((path: string) => Promise<unknown>)[],
	answer: (verb: 'create' | 'save') => Promise<unknown> = async () =>
		Ok(fileCapture('epicenter.json', '0'.repeat(64))),
) {
	const writes: { verb: 'create' | 'save'; text: string; options?: unknown }[] =
		[];
	let read = 0;
	const text = (content: string | Uint8Array) =>
		typeof content === 'string' ? content : new TextDecoder().decode(content);
	const files = {
		read: (path: string) => reads[Math.min(read++, reads.length - 1)]!(path),
		create: async (path: string, content: string | Uint8Array) => {
			expect(path).toBe('epicenter.json');
			writes.push({ verb: 'create', text: text(content) });
			return answer('create');
		},
		save: async (
			base: { path: string },
			content: string | Uint8Array,
			options?: unknown,
		) => {
			expect(base.path).toBe('epicenter.json');
			writes.push({ verb: 'save', text: text(content), options });
			return answer('save');
		},
	} as unknown as Parameters<typeof publishDefinition>[1];
	return { files, writes };
}

test('a missing declaration is created, and the attempt waits for the file outcome', async () => {
	const done = Promise.withResolvers<void>();
	const { files, writes } = recording([missing], async () => {
		await done.promise;
		return Ok(fileCapture('epicenter.json', '0'.repeat(64)));
	});
	let returned = false;
	const opening = publishDefinition(definition, files).then(() => {
		returned = true;
	});
	while (writes.length === 0) await Bun.sleep(1);
	expect(writes).toEqual([
		{ verb: 'create', text: formatDeclaration(definition) },
	]);
	expect(returned).toBe(false);
	done.resolve();
	await opening;
	expect(returned).toBe(true);
});

test('a file already holding the declaration bytes is not rewritten', async () => {
	const { files, writes } = recording([holding(formatDeclaration(definition))]);
	await publishDefinition(definition, files);
	expect(writes).toEqual([]);
	expect(events).toEqual([]);
});

for (const [name, read] of [
	['different bytes', holding('{"title":"Another app"}\n')],
	[
		'the same JSON without its trailing newline',
		holding(formatDeclaration(definition).trimEnd()),
	],
] as const)
	test(`${name} are saved over once, never merged`, async () => {
		const { files, writes } = recording([read]);
		await publishDefinition(definition, files);
		expect(writes).toEqual([
			{
				verb: 'save',
				text: formatDeclaration(definition),
				options: { merge: false },
			},
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
	const { files, writes } = recording([holding(formatDeclaration(theirs))]);
	await publishDefinition(own, files);
	expect(writes).toEqual([
		{ verb: 'save', text: formatDeclaration(both), options: { merge: false } },
	]);
	// A file already listing them all, and this definition's, is left alone.
	const again = recording([holding(formatDeclaration(both))]);
	await publishDefinition(own, again.files);
	expect(again.writes).toEqual([]);
});

test('another writer getting there first is read once more', async () => {
	const conflict = FileError.Conflict({
		path: 'epicenter.json',
		expectedSha256: '0'.repeat(64),
		actualSha256: '1'.repeat(64),
	});
	let saves = 0;
	const { files, writes } = recording(
		[missing, holding('{"title":"Another app"}\n')],
		async (verb) => {
			if (verb === 'create')
				return FileError.Exists({ path: 'epicenter.json' });
			saves++;
			return saves === 1
				? conflict
				: Ok(fileCapture('epicenter.json', '0'.repeat(64)));
		},
	);
	await publishDefinition(definition, files);
	expect(writes.map((write) => write.verb)).toEqual(['create', 'save']);
	// Two reads at most: the save's Conflict is the last word.
	expect(events).toHaveLength(1);
	expect(events[0]?.data).toMatchObject({ cause: conflict.error });
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
		const { files, writes } = recording([read]);
		await publishDefinition(definition, files);
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
	const { files } = recording([missing], async () => refusal);
	await publishDefinition(definition, files);
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
	const { files } = recording([missing], async () => {
		throw cause;
	});
	await publishDefinition(definition, files);
	expect(events).toHaveLength(1);
	expect(events[0]?.data).toMatchObject({
		name: 'DefinitionPublicationUnconfirmed',
		path: 'epicenter.json',
		cause,
	});
});
