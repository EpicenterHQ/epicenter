import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const appSource = resolve(import.meta.dir, '../../app/src/index.ts');

/** Create isolated app homes and run the real entrypoint so output and exit codes are tested together. */
export async function fixture() {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), 'epicenter-runner-')),
	);
	const home = join(root, 'home');
	const cache = join(root, 'cache');
	await mkdir(home);
	const env = {
		...process.env,
		EPICENTER_HOME: home,
		EPICENTER_CACHE_HOME: cache,
		EPICENTER_SKIP_INSTALL: '1',
		GIT_AUTHOR_NAME: 'Epicenter Test',
		GIT_AUTHOR_EMAIL: 'epicenter-test@example.com',
		GIT_COMMITTER_NAME: 'Epicenter Test',
		GIT_COMMITTER_EMAIL: 'epicenter-test@example.com',
		EPICENTER_TEST_SECRETS: JSON.stringify({
			'epicenter.reading': { seed: 'plain seed' },
			'epicenter.other': { foreign: 'hidden' },
		}),
	};
	async function app(entry: string, source: string, parent = home) {
		const dir = join(parent, entry);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, 'epicenter.ts'),
			`import { defineApp, field } from ${JSON.stringify(appSource)};\n${source}`,
		);
		for (const args of [
			['init', '-q'],
			['config', 'user.name', 'Epicenter Test'],
			['config', 'user.email', 'epicenter-test@example.com'],
			['add', '-A'],
			['commit', '-q', '--no-verify', '-m', 'initial'],
		]) {
			const child = Bun.spawn(['git', '-C', dir, ...args], {
				stdout: 'pipe',
				stderr: 'pipe',
			});
			const [stderr, code] = await Promise.all([
				new Response(child.stderr).text(),
				child.exited,
			]);
			if (code !== 0) throw new Error(stderr);
		}
		return dir;
	}
	async function run(...args: string[]) {
		const child = Bun.spawn(
			[process.execPath, resolve(import.meta.dir, 'bin.ts'), ...args],
			{ env, stdout: 'pipe', stderr: 'pipe' },
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, code };
	}
	return { root, home, cache, env, app, run };
}

export const reading = `export default defineApp({ name: 'reading', description: 'Reading records', actions: {
	log: { description: 'Record reading', input: { minutes: field.number({positional:true}), book: field.text({optional:true}) }, run: async (input, {folder}) => { await folder.write('records/log.json', JSON.stringify(input)); return input; } },
	'week summary': { description: 'Weekly minutes', input: {}, readOnly:true, run: () => ({minutes:210}) },
	tag: { description:'Tag records', input: { tags: field.tags(), done: field.boolean() }, run: (input) => input },
	collect: { description:'Collect tags', input: { tags: field.tags({positional:true}) }, run: (input) => input },
	inspect: { description:'Inspect the context', input:{}, run: async (_, {folder,cache,secrets}) => { const db = cache.sqlite('index'); db.run('CREATE TABLE IF NOT EXISTS items (id INTEGER)'); db.close(); await secrets.set('token','round trip'); return {folder:folder.path,cache:cache.path,token:await secrets.get('token'),seed:await secrets.get('seed'),foreign:await secrets.get('foreign') ?? null}; } },
	explode: { description:'Throw an error', input:{}, run: () => {throw new Error('action exploded');} },
} });`;

export const vault = `export default defineApp({name:'vault',description:'Calendar',actions:{
	'calendar show': {description:'Show a day',readOnly:true,input:{day:field.date({positional:true})},run:({day})=>({day})},
	'calendar add': {description:'Add a day',destructive:true,input:{day:field.date({positional:true})},run:({day})=>({day})},
}});`;
