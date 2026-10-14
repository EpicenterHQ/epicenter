/**
 * Publication attempt contract: an awaited write when the file does not hold
 * the declaration's bytes, no write when it does, and failure diagnostics
 * retaining uncertain outcomes.
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

test('a missing declaration is written, and the attempt waits for the file outcome', async () => {
	const written: string[] = [];
	const done = Promise.withResolvers<void>();
	const files = {
		read: missing,
		overwrite: async (path: string, content: string | Uint8Array) => {
			expect(path).toBe('epicenter.json');
			written.push(
				typeof content === 'string'
					? content
					: new TextDecoder().decode(content),
			);
			await done.promise;
			return Ok(fileCapture(path, '0'.repeat(64)));
		},
	};
	let returned = false;
	const opening = publishDefinition(definition, files).then(() => {
		returned = true;
	});
	while (written.length === 0) await Promise.resolve();
	expect(written).toEqual([formatDeclaration(definition)]);
	expect(returned).toBe(false);
	done.resolve();
	await opening;
	expect(returned).toBe(true);
});

test('a file already holding the declaration bytes is not rewritten', async () => {
	let writes = 0;
	await publishDefinition(definition, {
		read: holding(formatDeclaration(definition)),
		overwrite: async (path) => {
			writes++;
			return Ok(fileCapture(path, '0'.repeat(64)));
		},
	});
	expect(writes).toBe(0);
	expect(events).toEqual([]);
});

for (const [name, read] of [
	['different bytes', holding('{"title":"Another app"}\n')],
	[
		'the same JSON without its trailing newline',
		holding(formatDeclaration(definition).trimEnd()),
	],
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
	test(`${name} falls through to one write`, async () => {
		let writes = 0;
		await publishDefinition(definition, {
			read,
			overwrite: async (path) => {
				writes++;
				return Ok(fileCapture(path, '0'.repeat(64)));
			},
		});
		expect(writes).toBe(1);
	});

test('a lost write reply preserves Unconfirmed and its actual cause in the diagnostic', async () => {
	const lost = new Error('Lost native reply after sending overwrite');
	const refusal = FileError.Unconfirmed({
		operation: 'overwrite',
		path: 'epicenter.json',
		cause: lost,
	});
	await publishDefinition(definition, {
		read: missing,
		overwrite: async () => refusal,
	});
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
	const cause = new Error('Connection closed after sending overwrite');
	await publishDefinition(definition, {
		read: missing,
		overwrite: async () => {
			throw cause;
		},
	});
	expect(events).toHaveLength(1);
	expect(events[0]?.data).toMatchObject({
		name: 'DefinitionPublicationUnconfirmed',
		path: 'epicenter.json',
		cause,
	});
});
