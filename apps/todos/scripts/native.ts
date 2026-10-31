/**
 * Todos over a directory on this computer, through the contract's client
 * (`openDevice` from `@epicenter/folder/node`). No account, server or Git.
 *
 *   bun apps/todos/scripts/native.ts <directory> <list|create|complete> [args]
 */
import { timeId } from '@epicenter/definition/ids';
import { openDevice } from '@epicenter/folder/node';
import { unwrap } from 'wellcrafted/result';
import { todos } from '../src/lib/contract.ts';

const [directory, command, ...args] = process.argv.slice(2);
if (directory === undefined || command === undefined) {
	console.error(
		'Usage: bun apps/todos/scripts/native.ts <directory> <list|create|complete> [args]',
	);
	process.exit(2);
}

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const device = unwrap(await openDevice(todos, { path: directory }));

async function main(): Promise<number> {
	switch (command) {
		case 'list': {
			const listed = await device.todos.list();
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
			const created = await device.todos.create({
				id: timeId(),
				title,
				done: false,
			});
			if (created.error !== null) {
				print({ error: created.error.message });
				return 1;
			}
			print({ created: created.data.id });
			return 0;
		}
		case 'complete': {
			const id = args[0];
			if (id === undefined) {
				print({ error: 'complete needs an id' });
				return 2;
			}
			const todo = await device.todos.get({ id });
			if (todo.error !== null) {
				print({ error: todo.error.message });
				return 1;
			}
			const completed = await device.todos.update(
				{ id },
				{ done: true },
				{ over: todo.data.version },
			);
			if (completed.error !== null) {
				print({ error: completed.error.message });
				return 1;
			}
			print({ completed: id });
			return 0;
		}
		default:
			console.error(`Unknown command: ${command}`);
			return 2;
	}
}

process.exit(await main());
