/**
 * Declaration mutations preserve independent sections under real CAS outcomes.
 * Regressions cover one-line concurrent edits, newly conflicting imports, ambiguous replies, and duplicate-key data.
 */
import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { FolderStorage } from './boundary.js';
import {
	importTables,
	writeGeneratedDeclaration,
} from './declaration-write.js';
import { FileError } from './errors.js';
import { hashBytes } from './hash.js';
import { exportTables } from './schema-export.js';

const tasks = {
	type: 'object',
	properties: { title: { type: 'string' } },
	required: ['title'],
};
const notes = { type: 'object', properties: { body: { type: 'string' } } };

function setup(
	source: string | null,
	concurrent?: (source: string | null) => string,
) {
	let current = source;
	let puts = 0;
	const storage: Pick<FolderStorage, 'read' | 'put'> = {
		async read(path) {
			if (current === null) return FileError.NotFound({ path });
			const bytes = new TextEncoder().encode(current);
			return Ok({ bytes, sha256: await hashBytes(bytes), stamp: `test:${current}` });
		},
		async put(_path, bytes, expected) {
			puts++;
			if (puts === 1 && concurrent !== undefined) current = concurrent(current);
			const hash =
				current === null
					? null
					: await hashBytes(new TextEncoder().encode(current));
			const holds =
				expected === 'absent'
					? hash === null
					: typeof expected === 'object' && hash === expected.sha256;
			if (!holds) return Ok({ kind: 'stale' });
			current = bytes === null ? null : new TextDecoder().decode(bytes);
			return Ok({ kind: 'landed', stamp: current === null ? null : `test:${current}` });
		},
	};
	return { storage, source: () => current, puts: () => puts };
}

test('import preserves opaque views, title and editor hints while adding tables', async () => {
	const original = {
		title: 'Personal',
		$schema: 'editor-schema',
		views: { future: { type: 'future', opaque: [1, 2] } },
		tables: { notes },
	};
	const fixture = setup(JSON.stringify(original));
	expectOk(
		await importTables(fixture.storage, JSON.stringify({ tables: { tasks } })),
	);
	expect(JSON.parse(fixture.source() ?? '')).toEqual({
		...original,
		tables: { notes, tasks },
	});
});

test('a conflicting table is unchanged unless replacement was explicitly chosen', async () => {
	const original = { tables: { tasks: notes, notes }, views: {} };
	const fixture = setup(JSON.stringify(original));
	expect(
		expectErr(
			await importTables(
				fixture.storage,
				JSON.stringify({ tables: { tasks } }),
			),
		).reason,
	).toContain('--replace');
	expect(fixture.puts()).toBe(0);
	expectOk(
		await importTables(fixture.storage, JSON.stringify({ tables: { tasks } }), {
			replace: true,
		}),
	);
	expect(JSON.parse(fixture.source() ?? '')).toEqual({
		...original,
		tables: { tasks, notes },
	});
	expect(
		expectOk(
			await importTables(
				fixture.storage,
				JSON.stringify({ tables: { tasks } }),
			),
		),
	).toEqual({ written: false });
});

test('an independent saved view added to one-line JSON survives a stale import', async () => {
	const fixture = setup(
		'{"tables":{}}',
		() =>
			'{"tables":{},"views":{"recent":{"type":"grid","table":"tasks","title":"Recent"}}}',
	);
	expectOk(
		await importTables(fixture.storage, JSON.stringify({ tables: { tasks } })),
	);
	expect(fixture.puts()).toBe(2);
	expect(JSON.parse(fixture.source() ?? '')).toEqual({
		tables: { tasks },
		views: { recent: { type: 'grid', table: 'tasks', title: 'Recent' } },
	});
});

test('a table that becomes conflicting before publication requires replacement on retry', async () => {
	const concurrent = JSON.stringify({
		tables: { tasks: notes },
		views: { keep: { untouched: true } },
	});
	const fixture = setup('{"tables":{}}', () => concurrent);
	expect(
		expectErr(
			await importTables(
				fixture.storage,
				JSON.stringify({ tables: { tasks } }),
			),
		).reason,
	).toContain('--replace');
	expect(fixture.source()).toBe(concurrent);
	expect(fixture.puts()).toBe(1);
});

test('generate changes its owned sections and retains concurrently added view configuration', async () => {
	const fixture = setup(
		'{"title":"Old","tables":{}}',
		() =>
			'{"title":"Old","tables":{},"$schema":"editor","views":{"keep":{"type":"future"}}}',
	);
	expectOk(
		await writeGeneratedDeclaration(
			fixture.storage,
			JSON.stringify({ title: 'New', tables: { tasks } }),
		),
	);
	expect(JSON.parse(fixture.source() ?? '')).toEqual({
		title: 'New',
		tables: { tasks },
		$schema: 'editor',
		views: { keep: { type: 'future' } },
	});
});

test('duplicate source keys, escaped aliases and malformed JSON never reach publication', async () => {
	for (const source of [
		'{"tables":{},"tables":{"notes":{}}}',
		'{"tables":{},"views":{"a":{"title":1,"ti\\u0074le":2}}}',
		'{"tables":',
	]) {
		const fixture = setup(source);
		expectErr(
			await importTables(
				fixture.storage,
				JSON.stringify({ tables: { tasks } }),
			),
		);
		expect(fixture.source()).toBe(source);
		expect(fixture.puts()).toBe(0);
	}
});

test('a lost successful publication is confirmed from the written bytes', async () => {
	const fixture = setup(null);
	const put = fixture.storage.put;
	fixture.storage.put = async (...args) => {
		const result = await put(...args);
		return result.data?.kind === 'landed'
			? FileError.Unconfirmed({
					path: 'epicenter.json',
					operation: 'write',
					cause: new Error('reply lost'),
				})
			: result;
	};
	expectOk(
		await importTables(fixture.storage, JSON.stringify({ tables: { tasks } })),
	);
	expect(fixture.puts()).toBe(1);
	expect(JSON.parse(fixture.source() ?? '')).toEqual({ tables: { tasks } });
});

test('app schema export preserves whole-table required and optional meaning', () => {
	const schema = Type.Object(
		{ title: Type.String(), done: Type.Optional(Type.Boolean()) },
		{ $defs: { label: { type: 'string', minLength: 1 } } },
	);
	const exported = expectOk(exportTables({ tasks: schema }));
	expect(exported).toEqual({
		tables: { tasks: JSON.parse(JSON.stringify(schema)) },
	});
	expect(exported.tables?.tasks?.required).toEqual(['title']);
});

test('numbers that would change during an unrelated import leave source bytes untouched', async () => {
	for (const number of [
		'9007199254740993',
		'1e400',
		'1e-400',
		'0.123456789012345678901234',
		'-0',
		'-0.0e20',
	]) {
		const source = `{"views":{"future":{"value":${number}}},"tables":{}}`;
		const fixture = setup(source);
		expect(
			expectErr(
				await importTables(
					fixture.storage,
					JSON.stringify({ tables: { tasks } }),
				),
			).reason,
		).toContain('cannot be preserved exactly');
		expect(fixture.source()).toBe(source);
		expect(fixture.puts()).toBe(0);
	}
});

test('exact decimal spellings may normalize without changing their values', async () => {
	const fixture = setup(
		'{"views":{"future":{"values":[1.0,1000e-3,1.2300e2,9007199254740992,0e400]}},"tables":{}}',
	);
	expectOk(
		await importTables(fixture.storage, JSON.stringify({ tables: { tasks } })),
	);
	expect(JSON.parse(fixture.source() ?? '').views.future.values).toEqual([
		1, 1, 123, 9007199254740992, 0,
	]);
});

test('an unsafe number added concurrently is refused after a stale publication', async () => {
	const concurrent =
		'{"views":{"future":{"value":9007199254740993}},"tables":{}}';
	const fixture = setup('{"tables":{}}', () => concurrent);
	expectErr(
		await importTables(fixture.storage, JSON.stringify({ tables: { tasks } })),
	);
	expect(fixture.source()).toBe(concurrent);
	expect(fixture.puts()).toBe(1);
});

test('case-folded table collisions are refused even with explicit replacement', async () => {
	for (const replace of [false, true]) {
		const source = JSON.stringify({ tables: { notes } });
		const fixture = setup(source);
		expect(
			expectErr(
				await importTables(
					fixture.storage,
					JSON.stringify({ tables: { Notes: notes } }),
					{ replace },
				),
			).reason,
		).toContain('collides case-insensitively');
		expect(fixture.source()).toBe(source);
		expect(fixture.puts()).toBe(0);
	}
});

test('case-folded collision admission uses the latest tables on each retry', async () => {
	const concurrent = JSON.stringify({
		tables: { Notes: notes },
		views: { retained: {} },
	});
	const fixture = setup('{"tables":{}}', () => concurrent);
	expect(
		expectErr(
			await importTables(
				fixture.storage,
				JSON.stringify({ tables: { notes } }),
				{ replace: true },
			),
		).reason,
	).toContain('collides case-insensitively');
	expect(fixture.source()).toBe(concurrent);
	expect(fixture.puts()).toBe(1);
});

test('generate refuses a malformed table type before any publication', async () => {
	const source = '{"tables":{},"views":{"retained":{}}}';
	const fixture = setup(source);
	const generated = JSON.stringify({
		tables: {
			tasks: { type: 'object', properties: { title: { type: 'strng' } } },
		},
	});
	expectErr(await writeGeneratedDeclaration(fixture.storage, generated));
	expect(fixture.source()).toBe(source);
	expect(fixture.puts()).toBe(0);
});

test('app export refuses hidden refinements, codecs and guards with their field path', () => {
	const guarded = Type.String();
	Object.defineProperty(guarded, '~guard', { value: () => true });
	for (const field of [
		Type.Refine(Type.String(), (value) => value.length > 2),
		Type.Codec(Type.String())
			.Decode((value) => value.length)
			.Encode((value) => String(value)),
		guarded,
	]) {
		const error = expectErr(
			exportTables({ tasks: Type.Object({ title: field }) }),
		);
		expect(error.reason).toContain('tables.tasks.properties.title.~');
	}
});

test('app export does not invoke accessors or toJSON and refuses non-JSON runtime objects', () => {
	let invoked = 0;
	const getter = Type.String();
	Object.defineProperty(getter, 'minLength', {
		enumerable: true,
		get: () => {
			invoked++;
			return 1;
		},
	});
	const customized = Type.String();
	Object.defineProperty(customized, 'toJSON', {
		value: () => {
			invoked++;
			return { type: 'string' };
		},
	});
	for (const field of [
		getter,
		customized,
		Type.String({ default: new Date() }),
		Type.String({ default: new Map() }),
	])
		expectErr(exportTables({ tasks: Type.Object({ title: field }) }));
	expect(invoked).toBe(0);
});
