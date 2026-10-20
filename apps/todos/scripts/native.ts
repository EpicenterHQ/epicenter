/** Local Todos over an existing directory. No account, remote, or Git required. */
import { openFolder } from '@epicenter/folder/bun';
import { todosTables } from '../src/lib/definition.js';

const [directory, command, ...args] = process.argv.slice(2);
if (directory === undefined || command === undefined) {
	console.error(
		'Usage: bun apps/todos/scripts/native.ts <directory> <status|list|create|complete> [args]',
	);
	process.exit(2);
}

function print(value: unknown) {
	console.log(JSON.stringify(value, null, 2));
}

const opened = await openFolder({ directory, tables: todosTables });
if (opened.error !== null) {
	print({ error: opened.error.message });
	process.exit(1);
}
const folder = opened.data;

async function summary() {
	const listed = await folder.tables.todos.list();
	if (listed.error !== null) return { error: listed.error.message };
	return {
		todos: listed.data
			.filter((row) => row.issues === null)
			.map((row) => ({
				path: `todos/${row.id}.md`,
				id: row.id,
				title: row.fields.title,
				done: row.fields.done,
			})),
		invalid: listed.data
			.filter((row) => row.issues !== null)
			.map((row) => ({
				id: row.id,
				issues: row.issues,
			})),
	};
}

let exitCode = 0;
try {
	switch (command) {
		case 'status':
			print({ directory, status: folder.getStatus(), ...(await summary()) });
			break;
		case 'list':
			print(await summary());
			break;
		case 'create': {
			const title = args.join(' ').trim();
			if (title === '') throw new Error('create needs a title');
			const id = crypto.randomUUID();
			const result = await folder.tables.todos.set(id, null, {
				fields: { title, done: false },
				body: '',
			});
			if (result.error !== null) exitCode = 1;
			print(
				result.error === null
					? { created: `todos/${id}.md` }
					: { error: result.error.message },
			);
			break;
		}
		case 'complete': {
			const id = args[0];
			if (id === undefined) throw new Error('complete needs an id');
			const read = await folder.tables.todos.get(id);
			if (read.error !== null || read.data === undefined) {
				exitCode = 1;
				print({ error: read.error?.message ?? `No todo named ${id}` });
				break;
			}
			const saved = await folder.tables.todos.set(id, read.data, {
				fields: { done: true },
			});
			if (saved.error !== null) exitCode = 1;
			print(
				saved.error === null
					? { updated: `todos/${id}.md` }
					: { error: saved.error.message },
			);
			break;
		}
		default:
			exitCode = 2;
			console.error(`Unknown command: ${command}`);
	}
} finally {
	await folder.close();
}
process.exit(exitCode);
