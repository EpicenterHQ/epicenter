/**
 * Todos over a directory on this computer, through the folder opened there
 * (`openFolder` at `directory` from `@epicenter/folder/node`). No account,
 * server or Git.
 *
 *   bun apps/todos/scripts/native.ts <directory> <list|create|complete> [args]
 */
import { timeId } from '@epicenter/definition/ids';
import { openFolder } from '@epicenter/folder';
import { directory } from '@epicenter/folder/node';
import { todos } from '../src/lib/contract.ts';
import { todoPath } from '../src/lib/todos.ts';

const [root, command, ...args] = process.argv.slice(2);
if (root === undefined || command === undefined) {
	console.error(
		'Usage: bun apps/todos/scripts/native.ts <directory> <list|create|complete> [args]',
	);
	process.exit(2);
}

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const folder = openFolder(todos, directory(root));

async function main(): Promise<number> {
	switch (command) {
		case 'list': {
			const listed = await folder.todos.list();
			if (listed.error !== null) {
				print({ error: listed.error.message });
				return 1;
			}
			print({
				todos: listed.data.items.map(({ id, title, done }) => ({
					id,
					title,
					done,
				})),
				invalid: listed.data.invalid.map(({ path, issues }) => ({
					path,
					issues,
				})),
			});
			return 0;
		}
		case 'create': {
			const title = args.join(' ').trim();
			if (title === '') {
				print({ error: 'create needs a title' });
				return 2;
			}
			const id = timeId();
			await folder.todos.set({ id }, { title, done: false });
			print({ created: id });
			return 0;
		}
		case 'complete': {
			const id = args[0];
			if (id === undefined) {
				print({ error: 'complete needs an id' });
				return 2;
			}
			// `set` makes a note where none is: complete only a todo that is there.
			const listed = await folder.todos.list();
			if (listed.error !== null) {
				print({ error: listed.error.message });
				return 1;
			}
			if (folder.todos.get({ id }) === undefined) {
				print({ error: `No todo is at ${todoPath(id)}` });
				return 1;
			}
			await folder.todos.set({ id }, { done: true });
			print({ completed: id });
			return 0;
		}
		default:
			console.error(`Unknown command: ${command}`);
			return 2;
	}
}

const code = await main();
folder[Symbol.dispose]();
process.exit(code);
