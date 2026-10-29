/** Local Todos over an existing directory. No account, remote, or Git required. */
import { openFolder } from '@epicenter/folder/bun';
import { todosTables } from '../src/definition.js';

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

function summary() {
	const rows = folder.tables.todos.rows();
	return {
		todos: rows
			.filter((row) => row.issues === null)
			.map((row) => ({
				path: `todos/${row.id}.md`,
				id: row.id,
				title: row.fields.title,
				done: row.fields.done,
			})),
		invalid: rows
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
			print({ directory, ...summary() });
			break;
		case 'list':
			print(summary());
			break;
		case 'create': {
			const title = args.join(' ').trim();
			if (title === '') throw new Error('create needs a title');
			const id = crypto.randomUUID();
			const result = await folder.tables.todos.create(id, {
				fields: { title, done: false },
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
			if (folder.tables.todos.row(id) === undefined) {
				exitCode = 1;
				print({ error: `There is no todo at todos/${id}.md` });
				break;
			}
			const saved = await folder.tables.todos.update(id, {
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
