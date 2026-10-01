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
 * The CLI opens the folder with `commitOnEdit: false`: a command saves files,
 * then `create` and `complete` request one explicit commit and push.
 */
import { openNativeFolder } from '@epicenter/app/files/native';
import { todosDefinition } from '../src/lib/definition.js';

const [root, command, ...args] = process.argv.slice(2);
if (root === undefined || command === undefined) {
	console.error(
		'Usage: bun apps/todos/scripts/native.ts <checkout> <status|list|create|complete|commit-and-push|fetch|pull> [args]',
	);
	process.exit(2);
}

async function output(cwd: string, ...gitArgs: string[]) {
	const child = Bun.spawn(['git', ...gitArgs], {
		cwd,
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
const folder = await openNativeFolder({
	root,
	definition: todosDefinition,
	git: {
		author: {
			name: (await output(root, 'config', 'user.name')) ?? 'Native Todos',
			email: (await output(root, 'config', 'user.email')) ?? 'native@localhost',
		},
		remote:
			remoteUrl === undefined ? undefined : { url: remoteUrl, branch: 'main' },
		commitOnEdit: false,
	},
});

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
	const listed = await folder.tables.todos.list();
	if (listed.error) return { error: listed.error.message };
	return {
		todos: listed.data.entries.map((entry) => ({
			path: entry.path,
			stem: entry.stem,
			title: entry.fields.title,
			done: entry.fields.done,
			issues: entry.issues,
		})),
		unreadable: listed.data.unreadable.map((item) => ({
			path: item.path,
			error: item.error.message,
		})),
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
			const entry = await folder.tables.todos.get(stem);
			if (entry.error || entry.data === undefined) {
				exitCode = 1;
				print({ error: entry.error?.message ?? `No todo named ${stem}` });
				break;
			}
			const updated = await folder.tables.todos.update(entry.data, {
				fields: { done: true },
			});
			if (updated.error) {
				exitCode = 1;
				print({ error: updated.error.message });
				break;
			}
			print({
				updated: updated.data.path,
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
			const fetched = await folder.git.fetch();
			const pulled = fetched.error
				? fetched
				: await folder.git.pullFastForward();
			if (pulled.error) exitCode = 1;
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
