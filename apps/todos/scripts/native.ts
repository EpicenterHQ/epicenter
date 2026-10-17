/**
 * Native Todos CLI over an ordinary checkout, printing JSON.
 *
 *   bun apps/todos/scripts/native.ts <checkout> status
 *   bun apps/todos/scripts/native.ts <checkout> list
 *   bun apps/todos/scripts/native.ts <checkout> create "<title>"
 *   bun apps/todos/scripts/native.ts <checkout> complete <stem>
 *   bun apps/todos/scripts/native.ts <checkout> sync
 *
 * A command saves files, then `create` and `complete` run one Sync; saves
 * never commit on their own (ADR-0529). Sync records the files, fetches,
 * and merges what both sides changed into one commit, this checkout's
 * version winning, then pushes (ADR-0576). A checkout that cannot be opened
 * prints the refusal and exits 1.
 *
 * The checkout must hold Todos's `epicenter.json`, as a checkout of a folder
 * Todos synced does, or be a directory named `so.epicenter.todos`, Todos's
 * own folder, where this script publishes `todosDefinition` on the first
 * write. Any other checkout is read through the definition and never
 * written over (ADR-0583), so an empty one is refused with how to fix it.
 */
import { openFolder } from '@epicenter/folder/bun';
import { todosDefinition } from '../src/lib/definition.js';
import { TODOS_FOLDER_ID } from '../src/lib/platform/types.js';

const [root, command, ...args] = process.argv.slice(2);
if (root === undefined || command === undefined) {
	console.error(
		"Usage: bun apps/todos/scripts/native.ts <checkout> <status|list|create|complete|sync> [args]\n<checkout> holds Todos's epicenter.json, or is a directory named so.epicenter.todos.",
	);
	process.exit(2);
}

/** A Git setting of the checkout, or undefined when Git has none or cannot read it. */
async function output(checkout: string, ...gitArgs: string[]) {
	// `-C`, not a working directory: a checkout that does not exist is then
	// Git's refusal here and the opener's `InvalidRoot` below, not a failed spawn.
	const child = Bun.spawn(['git', '-C', checkout, ...gitArgs], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, code] = await Promise.all([
		new Response(child.stdout).text(),
		child.exited,
	]);
	return code === 0 ? stdout.trim() : undefined;
}

const remoteUrl = await output(root, 'remote', 'get-url', 'origin');
const { data: openedFolder, error: openedError } = await openFolder({
	root,
	app: TODOS_FOLDER_ID,
	definition: todosDefinition,
	git: {
		author: {
			name: (await output(root, 'config', 'user.name')) ?? 'Native Todos',
			email: (await output(root, 'config', 'user.email')) ?? 'native@localhost',
		},
	},
});
if (openedError) {
	print({
		error:
			openedError.name === 'DefinitionMismatch'
				? `${openedError.message} Use a checkout of a folder Todos synced, which holds its epicenter.json, or a directory named ${TODOS_FOLDER_ID}, which Todos publishes its declaration into.`
				: openedError.message,
	});
	process.exit(1);
}

const folder = openedFolder;

function print(value: unknown) {
	console.log(
		JSON.stringify(
			value,
			(_key, item) =>
				item instanceof Uint8Array ? `<${item.byteLength} bytes>` : item,
			2,
		),
	);
}

async function summary() {
	const { data: listed, error: listedError } = await folder.tables.todos.list();
	if (listedError) return { error: listedError.message };
	// One line per row file: a todo, or why its text is not one.
	return {
		todos: listed.flatMap(({ stem, result: { data, error } }) =>
			error
				? []
				: {
						path: data.path,
						stem,
						title: data.row.fields.title,
						done: data.row.fields.done,
					},
		),
		invalid: listed.flatMap(({ stem, result: { error } }) =>
			error ? { stem, error: error.message } : [],
		),
	};
}

let exitCode = 0;
try {
	switch (command) {
		case 'status': {
			const status = await folder.git.status();
			print({
				root,
				remote: remoteUrl,
				status,
				snapshot: folder.git.snapshot,
				...(await summary()),
			});
			break;
		}
		case 'list':
			print(await summary());
			break;
		case 'create': {
			const title = args.join(' ').trim();
			if (title === '') throw new Error('create needs a title');
			const created = await folder.tables.todos.create({
				fields: { title, done: false },
				body: '',
			});
			if (created.error) {
				exitCode = 1;
				print({ created });
				break;
			}
			print({
				created: created.data?.path ?? null,
				sync: await folder.sync.run(),
			});
			break;
		}
		case 'complete': {
			const stem = args[0];
			if (stem === undefined) throw new Error('complete needs a stem');
			// Marked done on the row as it is now: a field set keeps every other
			// field and the body another writer changed, and writes nothing
			// when no todo is there (ADR-0576).
			const { data: updated, error } = await folder.tables.todos.set(stem, {
				done: true,
			});
			if (error || updated === null) {
				exitCode = 1;
				print({ error: error?.message ?? `No todo named ${stem}` });
				break;
			}
			print({
				updated: updated.path,
				sync: await folder.sync.run(),
			});
			break;
		}
		case 'sync': {
			const synced = await folder.sync.run();
			if (synced.error) exitCode = 1;
			print(synced);
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
