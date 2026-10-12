/**
 * Native Todos CLI over an ordinary checkout, printing JSON.
 *
 *   bun apps/todos/scripts/native.ts <checkout> status
 *   bun apps/todos/scripts/native.ts <checkout> list
 *   bun apps/todos/scripts/native.ts <checkout> create "<title>"
 *   bun apps/todos/scripts/native.ts <checkout> complete <stem>
 *   bun apps/todos/scripts/native.ts <checkout> commit-and-push
 *   bun apps/todos/scripts/native.ts <checkout> fetch
 *   bun apps/todos/scripts/native.ts <checkout> pull
 *
 * A command saves files, then `create` and `complete` request one explicit
 * commit and push; saves never commit on their own (ADR-0529). `pull`
 * applies only a fast-forward; diverged history is refused with the folder's
 * pointer to Sync, and nothing is written. A
 * checkout that cannot be opened prints the refusal and exits 1.
 */
import { CONFLICTS_NEED_SYNC } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/bun';
import { todosDefinition } from '../src/lib/definition.js';

const [root, command, ...args] = process.argv.slice(2);
if (root === undefined || command === undefined) {
	console.error(
		'Usage: bun apps/todos/scripts/native.ts <checkout> <status|list|create|complete|commit-and-push|fetch|pull> [args]',
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
	definition: todosDefinition,
	git: {
		author: {
			name: (await output(root, 'config', 'user.name')) ?? 'Native Todos',
			email: (await output(root, 'config', 'user.email')) ?? 'native@localhost',
		},
		remote:
			remoteUrl === undefined ? undefined : { url: remoteUrl, branch: 'main' },
	},
});
if (openedError) {
	print({ error: openedError.message });
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
				created: created.data.path,
				history: await folder.git.commitAndPush(),
			});
			break;
		}
		case 'complete': {
			const stem = args[0];
			if (stem === undefined) throw new Error('complete needs a stem');
			// Marked done over the row as it is read now, guarded by that read.
			const { data: current, error: readError } =
				await folder.tables.todos.get(stem);
			if (readError || current === undefined) {
				exitCode = 1;
				print({ error: readError?.message ?? `No todo named ${stem}` });
				break;
			}
			const { data: updated, error: updatedError } =
				await folder.tables.todos.replace(current, {
					...current.row,
					fields: { ...current.row.fields, done: true },
				});
			if (updatedError) {
				exitCode = 1;
				print({ error: updatedError.message });
				break;
			}
			print({
				updated: updated.path,
				history: await folder.git.commitAndPush(),
			});
			break;
		}
		case 'commit-and-push':
			print(await folder.git.commitAndPush());
			break;
		case 'fetch':
			print(await folder.git.fetch());
			break;
		case 'pull': {
			// A fast-forward only. Diverged history is not merged here: the folder
			// never leaves a conflict in its files, and Sync settles one.
			const fetched = await folder.git.fetch();
			const pulled = fetched.error
				? fetched
				: await folder.git.pullFastForward();
			if (pulled.error) exitCode = 1;
			if (pulled.error?.name === 'Diverged') console.error(CONFLICTS_NEED_SYNC);
			print({ fetched, pulled });
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
