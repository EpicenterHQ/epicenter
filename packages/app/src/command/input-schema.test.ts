/**
 * An action's input is one JSON Schema object (ADR-0953)
 *
 * Every declaration this repository ships, the example apps and the data
 * actions `defineData` generates for a folder key and a one-file key, carries
 * an input that survives `JSON.stringify` whole: what an agent, a page, or
 * another language receives is what validation uses.
 *
 * Key behaviors:
 * - the JSON copy deep-equals the schema, and `required` names exactly the
 *   keys a caller must give, `[]` when none is
 * - `Value.Check` answers alike on the copy and the original
 * - MCP's `inputSchema` and `list --json` carry the same object
 */
import { expect, setDefaultTimeout, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Value } from 'typebox/value';
import { type Action, type App, type Folder, folderOnDisk } from '../index.ts';
import { exampleCommand } from './input.ts';
import { connectMcp, fixture } from './runner.test-support.ts';

// The public-surface test runs the real serve and command.
setDefaultTimeout(30_000);

const examples = join(import.meta.dir, '../../../../examples');

/** Generated data actions for a folder key and a one-file key, with a field of each kind. */
const generated = `export default defineApp(({ folder }) => {
const data = defineData(folder, {
	shelves: { fields: {} },
	notes: {
		description: 'note',
		fields: {
			title: field.text(),
			subtitle: field.text({ optional: true }),
			pinned: field.boolean(),
			tags: field.list(field.text()),
			authors: field.list(field.text(), { min: 1 }),
			kind: field.select(['thought', 'quote']),
			day: field.date({ optional: true }),
			shelf: field.ref('shelves', { optional: true }),
		},
	},
	'settings.md': {
		fields: { theme: field.select(['light', 'dark']), size: field.integer({ optional: true }) },
	},
});
const settings = data['settings.md'].actions('get', 'patch', 'edit', 'delete');
return { description: 'Generated data actions', data, actions: {
	...data.notes.actions('list', 'get', 'create', 'patch', 'edit', 'delete'),
	'get-settings': settings.get,
	'patch-settings': settings.patch,
	'edit-settings': settings.edit,
	'delete-settings': settings.delete,
} };
});
`;

/** The keys each action requires, written out so a lost `required` cannot agree with itself. */
const REQUIRED: Record<string, Record<string, string[]>> = {
	tasks: {
		list: [],
		get: ['id'],
		patch: ['id'],
		edit: ['id', 'old', 'new'],
		delete: ['id'],
		add: ['title'],
	},
	writing: {
		list: [],
		get: ['id'],
		patch: ['id'],
		edit: ['id', 'old', 'new'],
		add: ['body'],
		search: [],
	},
	data: {
		list: [],
		get: ['id'],
		create: ['title', 'authors', 'kind'],
		patch: ['id'],
		edit: ['id', 'old', 'new'],
		delete: ['id'],
		'get-settings': [],
		'patch-settings': [],
		'edit-settings': ['old', 'new'],
		'delete-settings': [],
	},
};

/** An Epicenter holding the example apps and the generated data actions, each loaded here too. */
async function epicenterOfExamples() {
	const f = await fixture();
	const read = (path: string) => readFile(join(examples, path), 'utf8');
	await f.folder(join(f.apps, 'tasks'), {
		'code/epicenter.ts': await read('tasks/epicenter.ts'),
		'code/data.ts': await read('tasks/data.ts'),
	});
	await f.folder(join(f.apps, 'writing'), {
		'code/epicenter.ts': await read('writing/epicenter.ts'),
	});
	await f.app('data', generated);
	const apps: Record<string, [string, Action][]> = {};
	for (const name of Object.keys(REQUIRED)) {
		const entry = join(f.apps, name, 'code', 'epicenter.ts');
		const define = (await import(entry)).default as (given: {
			folder: Folder;
		}) => App;
		const app = define({ folder: folderOnDisk(join(f.apps, name)) });
		apps[name] = Object.entries(app.actions);
	}
	return { f, apps };
}

/** The input `--help` shows for an action, read back from its command. */
function exampleOf(name: string, key: string, action: Action) {
	const command = exampleCommand(name, key, action.input);
	const text = command.slice(command.indexOf("'") + 1, -1);
	return JSON.parse(text.replaceAll(`'\\''`, "'")) as Record<string, unknown>;
}

test('every action input survives JSON whole, names its required keys, and validates alike', async () => {
	const { f, apps } = await epicenterOfExamples();
	try {
		for (const [name, actions] of Object.entries(apps)) {
			expect(actions.map(([key]) => key)).toEqual(
				Object.keys(REQUIRED[name] ?? {}),
			);
			for (const [key, action] of actions) {
				const original = action.input;
				const copy = JSON.parse(JSON.stringify(original));
				expect(copy).toEqual(original);
				expect(copy).toMatchObject({
					type: 'object',
					additionalProperties: false,
				});
				expect(copy.required).toEqual(REQUIRED[name]?.[key]);

				const valid = exampleOf(name, key, action);
				const [first] = Object.keys(original.properties);
				const [needed] = original.required;
				const cases = [
					[valid, true],
					[{ ...valid, unknown: 1 }, false],
					...(needed === undefined
						? []
						: [[{ ...valid, [needed]: undefined }, false] as const]),
					...(first === undefined
						? []
						: [[{ ...valid, [first]: { wrong: true } }, false] as const]),
				] as const;
				for (const [input, fits] of cases) {
					const given = JSON.parse(JSON.stringify(input));
					expect([key, Value.Check(original, given)]).toEqual([key, fits]);
					expect([key, Value.Check(copy, given)]).toEqual([key, fits]);
				}
			}
		}
	} finally {
		await rm(f.userDir, { recursive: true, force: true });
	}
});

test('MCP inputSchema and list --json carry the same complete schema as the action', async () => {
	const { f, apps } = await epicenterOfExamples();
	const { client, close } = await connectMcp(f);
	try {
		const { tools } = await client.listTools();
		for (const [name, actions] of Object.entries(apps)) {
			const listed = JSON.parse((await f.run(name, '--json')).stdout).data as {
				actions: { name: string; inputSchema: object }[];
			};
			for (const [key, action] of actions) {
				const tool = `${name}_${key}`;
				const stored = JSON.parse(JSON.stringify(action.input));
				expect(stored.required).toEqual(REQUIRED[name]?.[key]);
				expect(tools.find((each) => each.name === tool)?.inputSchema).toEqual(
					stored,
				);
				expect(
					listed.actions.find((each) => each.name === tool)?.inputSchema,
				).toEqual(stored);
			}
		}
	} finally {
		await close();
		await rm(f.userDir, { recursive: true, force: true });
	}
});
