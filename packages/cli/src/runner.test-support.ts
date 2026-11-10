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
 * tested together. Nothing here reads the person's own home or Keychain.
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
		EPICENTER_TEST_SECRETS: JSON.stringify({
			[`epicenter.${TEST_ROOT_ID}.reading`]: { seed: 'plain seed' },
			[`epicenter.${TEST_ROOT_ID}.other`]: { foreign: 'hidden' },
		}),
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
	 * An app at `parent/entry`: an `epicenter.json`, and an `epicenter.ts` of
	 * `source` with the declaration, `defineApp`, and `field` imported.
	 */
	async function app(entry: string, source: string, parent = home) {
		return folder(join(parent, entry), {
			'.gitignore': gitignore,
			'epicenter.json': declarationOf(entry),
			'epicenter.ts': `import declaration from './epicenter.json';\nimport { defineApp, field } from '@epicenter/app';\n${source}`,
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

/** Reading, as an app with both declaration files. */
export const readingApp = {
	'.gitignore': gitignore,
	'epicenter.json': `${JSON.stringify(
		{
			$schema: 'https://epicenter.so/epicenter.schema.json',
			description: 'How much I read each week',
			collections: {
				books: {
					path: 'books/{slug}.md',
					fields: {
						type: 'object',
						properties: { title: { type: 'string' } },
						required: ['title'],
					},
				},
			},
		},
		null,
		2,
	)}\n`,
	'epicenter.ts': `import declaration from './epicenter.json';
import { defineApp, field } from '@epicenter/app';

export default defineApp(declaration, {
	actions: {
		log: {
			description: 'Record minutes read today',
			input: { minutes: field.number(), book: field.text({ optional: true }) },
			positional: ['minutes'],
			run: async ({ minutes, book }, { folder }) => {
				const before = (await folder.read('2026.csv')) ?? 'minutes,book\\n';
				await folder.write('2026.csv', \`\${before}\${minutes},\${book ?? ''}\\n\`);
				return { minutes, book: book ?? null };
			},
		},
		between: {
			description: 'Minutes read between two days',
			input: { from: field.date(), to: field.date() },
			positional: ['from', 'to'],
			annotations: { readOnlyHint: true },
			run: ({ from, to }) => ({ from, to }),
		},
		'week show': {
			description: 'Minutes read this week',
			input: {},
			annotations: { readOnlyHint: true, openWorldHint: false },
			run: () => 210,
		},
		explode: {
			description: 'Write, then throw',
			input: {},
			run: async (_, { folder }) => {
				await folder.write('2026.csv', 'minutes,book\\n1,\\n');
				throw new Error('line 4 is not a number');
			},
		},
	},
});
`,
};

/** An epicenter.json with only a description that names the app. */
export function declarationOf(
	name: string,
	extra: Record<string, unknown> = {},
) {
	return `${JSON.stringify({ description: `The ${name} app`, ...extra }, null, 2)}\n`;
}

export const reading = `export default defineApp(declaration, { actions: {
	log: { description: 'Record reading', input: { minutes: field.number(), book: field.text({optional:true}) }, positional: ['minutes'], run: async (input, {folder}) => { await folder.write('records/log.json', JSON.stringify(input)); return input; } },
	'week summary': { description: 'Weekly minutes', input: {}, annotations: { readOnlyHint: true }, run: () => ({minutes:210}) },
	tag: { description:'Tag records', input: { tags: field.tags(), done: field.boolean() }, run: (input) => input },
	collect: { description:'Collect tags', input: { tags: field.tags() }, positional: ['tags'], run: (input) => input },
	inspect: { description:'Inspect the context', input:{}, run: async (_, {folder,secrets}) => { await folder.write('.cache/index.json', '{}'); await secrets.set('token','round trip'); return {folder:folder.path,token:await secrets.get('token'),seed:await secrets.get('seed'),foreign:await secrets.get('foreign') ?? null}; } },
	explode: { description:'Throw an error', input:{}, run: () => {throw new Error('action exploded');} },
} });`;

export const vault = `export default defineApp(declaration, { actions: {
	'calendar show': {description:'Show a day',annotations:{readOnlyHint:true,destructiveHint:false},input:{day:field.date()},positional:['day'],run:({day})=>({day})},
	'calendar add': {description:'Add a day',input:{day:field.date()},positional:['day'],run:({day})=>({day})},
} });`;
