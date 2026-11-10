import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const bin = resolve(import.meta.dir, 'bin.ts');
export const TEST_ROOT_ID = 'test-epicenter';

/** Run git in `dir`, throwing with its stderr when it fails. */
export async function gitIn(dir: string, ...args: string[]) {
	const child = Bun.spawn(['git', '-C', dir, ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`git ${args.join(' ')}: ${stderr}`);
	return stdout.trim();
}

/**
 * A temporary `HOME` whose `Epicenter` folder is the app home, and the real
 * `bin.ts` run against it, so output, exit codes, and the folders on disk are
 * tested together. Nothing here reads the person's own home.
 */
export async function fixture() {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'epicenter-runner-')),
	);
	const home = join(root, 'Epicenter');
	await mkdir(home);
	await writeFile(
		join(home, 'epicenter.root.json'),
		`${JSON.stringify({ id: TEST_ROOT_ID })}\n`,
	);
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: root,
		EPICENTER_ROOT: undefined,
		GIT_AUTHOR_NAME: 'Epicenter Test',
		GIT_AUTHOR_EMAIL: 'epicenter-test@example.com',
		GIT_COMMITTER_NAME: 'Epicenter Test',
		GIT_COMMITTER_EMAIL: 'epicenter-test@example.com',
	};

	/** Write `files` under `dir` and, unless `git` is false, commit them as a new repository. */
	async function folder(
		dir: string,
		files: Record<string, string>,
		{ git = true }: { git?: boolean } = {},
	) {
		await mkdir(dir, { recursive: true });
		for (const [path, text] of Object.entries(files)) {
			await mkdir(dirname(join(dir, path)), { recursive: true });
			await writeFile(join(dir, path), text);
		}
		if (git) {
			await gitIn(dir, 'init', '-q');
			await gitIn(dir, 'config', 'user.name', 'Epicenter Test');
			await gitIn(dir, 'config', 'user.email', 'epicenter-test@example.com');
			await gitIn(dir, 'add', '-A');
			await gitIn(dir, 'commit', '-q', '--no-verify', '-m', 'initial');
		}
		return dir;
	}

	/**
	 * An app at `parent/entry`: a `.gitignore`, and an `epicenter.ts` of
	 * `source` after an import of everything an app defines itself with.
	 */
	async function app(entry: string, source: string, parent = home) {
		return folder(join(parent, entry), {
			'.gitignore': gitignore,
			'epicenter.ts': `${header}${source}`,
		});
	}

	async function runIn(cwd: string, ...args: string[]) {
		const child = Bun.spawn([process.execPath, bin, ...args], {
			cwd,
			env,
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, code };
	}
	const run = (...args: string[]) => runIn(root, ...args);
	return { root, home, env, bin, folder, app, run, runIn };
}

/** The ignore file every test app carries, as `epicenter new` writes it. */
export const gitignore = 'node_modules/\n.cache/\n*.local\n*.local.*\n';

/** The import every test app's `epicenter.ts` starts with. */
export const header = `import { defineAction, defineApp, defineCollection, field, folder } from '@epicenter/app';\n`;

/** The `epicenter.ts` of an app with only a description that names it. */
export function bareApp(name: string) {
	return `${header}export default defineApp({ description: 'The ${name} app', collections: {}, actions: {} });\n`;
}

/** Reading, as an app's files: a books collection and actions that write a CSV. */
export const readingApp = {
	'.gitignore': gitignore,
	'epicenter.ts': `${header}
const books = defineCollection({ path: 'books/{slug}.md', fields: { title: field.text() } });

export default defineApp({
	description: 'How much I read each week',
	collections: { books },
	actions: {
		books: books.actions(),
		log: defineAction({
			description: 'Record minutes read today',
			input: { minutes: field.number(), book: field.text({ optional: true }) },
			positional: ['minutes'],
			run: async ({ minutes, book }) => {
				await folder.update('2026.csv', (before = 'minutes,book\\n') => \`\${before}\${minutes},\${book ?? ''}\\n\`);
				return { minutes, book: book ?? null };
			},
		}),
		between: defineAction({
			description: 'Minutes read between two days',
			input: { from: field.date(), to: field.date() },
			positional: ['from', 'to'],
			annotations: { readOnlyHint: true },
			run: ({ from, to }) => ({ from, to }),
		}),
		week: {
			show: defineAction({
				description: 'Minutes read this week',
				input: {},
				annotations: { readOnlyHint: true, openWorldHint: false },
				run: () => 210,
			}),
		},
		explode: defineAction({
			description: 'Write, then throw',
			input: {},
			run: async () => {
				await folder.write('2026.csv', 'minutes,book\\n1,\\n');
				throw new Error('line 4 is not a number');
			},
		}),
	},
});
`,
};

/** The source of an app with many kinds of input, for `fixture().app`. */
export const reading = `export default defineApp({ description: 'The reading app', collections: {}, actions: {
	log: defineAction({ description: 'Record reading', input: { minutes: field.number(), book: field.text({optional:true}) }, positional: ['minutes'], run: async (input) => { await folder.write('records/log.json', JSON.stringify(input)); return input; } }),
	week: { summary: defineAction({ description: 'Weekly minutes', input: {}, annotations: { readOnlyHint: true }, run: () => ({minutes:210}) }) },
	tag: defineAction({ description:'Tag records', input: { tags: field.tags(), done: field.boolean() }, run: (input) => input }),
	collect: defineAction({ description:'Collect tags', input: { tags: field.tags() }, positional: ['tags'], run: (input) => input }),
	inspect: defineAction({ description:'Inspect the context', input:{}, run: async () => { await folder.write('.cache/index.json', '{}'); return {folder:folder.path}; } }),
	explode: defineAction({ description:'Throw an error', input:{}, run: () => {throw new Error('action exploded');} }),
} });`;

/** The source of an app whose actions share the word `calendar`. */
export const vault = `export default defineApp({ description: 'The vault app', collections: {}, actions: { calendar: {
	show: defineAction({description:'Show a day',annotations:{readOnlyHint:true,destructiveHint:false},input:{day:field.date()},positional:['day'],run:({day})=>({day})}),
	add: defineAction({description:'Add a day',input:{day:field.date()},positional:['day'],run:({day})=>({day})}),
} } });`;
