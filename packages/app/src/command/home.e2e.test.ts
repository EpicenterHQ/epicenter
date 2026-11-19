/**
 * One home, end to end: a `package.json` marker, an `epicenter.ts` that
 * composes one app, `epicenter serve` running in it, and the command
 * calling an action that writes a Markdown record.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

setDefaultTimeout(30_000);

const bin = resolve(import.meta.dir, 'bin.ts');
const library = resolve(import.meta.dir, '..', '..');

const EPICENTER_TS = `import { defineData, defineEpicenter, field } from '@epicenter/app';
import { writing } from './apps/writing';

export const data = defineData(import.meta.dir, {
	notes: {
		description: 'writing note',
		fields: { kind: field.select(['thought', 'quote', 'link']) },
	},
});
export type Data = typeof data;

export default defineEpicenter({ apps: { writing: writing(data) } });
`;

const WRITING_TS = `import { defineAction, field, timeId, type Update } from '@epicenter/app';
import type { Data } from '../../epicenter';

export function writing({ notes }: Data) {
	const add = defineAction({
		description: 'Save a thought, quote or link, named by the time',
		input: {
			body: field.text({ pattern: '\\\\S' }),
			kind: field.select(['thought', 'quote', 'link'], { optional: true }),
		},
		run: async ({ body, kind = 'thought' }, update: Update<string>) => {
			update('saving');
			return notes.create(timeId(), { body, kind });
		},
	});
	return { description: 'Notes for later writing', actions: { add } };
}
`;

/** A port nothing listens on now. */
function freePort() {
	const probe = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () => new Response(),
	});
	const { port } = probe;
	probe.stop(true);
	return port;
}

let home: string;
let serve: ReturnType<typeof Bun.spawn>;

/** Run the command in the home, as a person would. */
async function epicenter(...args: string[]) {
	const run = Bun.spawn(['bun', bin, ...args], {
		cwd: home,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(run.stdout).text(),
		new Response(run.stderr).text(),
		run.exited,
	]);
	return { stdout, stderr, code };
}

beforeAll(async () => {
	home = await realpath(await mkdtemp(join(tmpdir(), 'epicenter-e2e-')));
	const port = freePort();
	await writeFile(
		join(home, 'package.json'),
		JSON.stringify({ private: true, epicenter: { port } }),
	);
	await writeFile(join(home, 'epicenter.ts'), EPICENTER_TS);
	await mkdir(join(home, 'apps', 'writing'), { recursive: true });
	await writeFile(join(home, 'apps', 'writing', 'index.ts'), WRITING_TS);
	// What `bun install` gives a home, without the network.
	await mkdir(join(home, 'node_modules', '@epicenter'), { recursive: true });
	await symlink(library, join(home, 'node_modules', '@epicenter', 'app'));
	serve = Bun.spawn(['bun', bin, 'serve'], {
		cwd: home,
		stdout: 'ignore',
		stderr: 'pipe',
	});
	// Serve says where it listens once it has loaded the program.
	const reader = (serve.stderr as ReadableStream<Uint8Array>)
		.pipeThrough(new TextDecoderStream())
		.getReader();
	let said = '';
	while (!said.includes('Listening on')) {
		const { done, value } = await reader.read();
		if (done) throw new Error(`serve stopped before listening:\n${said}`);
		said += value;
	}
	// Keep draining serve's run records so its pipe never fills.
	void (async () => {
		while (!(await reader.read()).done);
	})();
});

afterAll(async () => {
	serve?.kill('SIGTERM');
	await serve?.exited;
	await rm(home, { recursive: true, force: true });
});

test('epicenter lists the apps serve loaded', async () => {
	const { stdout, code } = await epicenter();
	expect(code).toBe(0);
	expect(stdout).toContain('writing  Notes for later writing');
	const app = await epicenter('writing');
	expect(app.stdout).toContain(
		'add  Save a thought, quote or link, named by the time (body, kind?)',
	);
});

test('epicenter writing add runs the action in serve and writes the Markdown record', async () => {
	const { stdout, stderr, code } = await epicenter(
		'writing',
		'add',
		'{"body":"Fares to Tokyo drop in late March"}',
	);
	expect(code).toBe(0);
	expect(stderr).toBe('"saving"\n');
	const record = JSON.parse(stdout);
	expect(record).toMatchObject({
		kind: 'thought',
		body: 'Fares to Tokyo drop in late March',
	});
	const files = await readdir(join(home, 'data', 'notes'));
	expect(files).toEqual([`${record.id}.md`]);
	expect(
		await readFile(join(home, 'data', 'notes', files[0] ?? ''), 'utf8'),
	).toBe('---\nkind: "thought"\n---\nFares to Tokyo drop in late March');
});

test('an input serve refuses exits 2 and writes nothing', async () => {
	const before = await readdir(join(home, 'data', 'notes'));
	const { stderr, code } = await epicenter('writing', 'add', '{"body":"  "}');
	expect(code).toBe(2);
	expect(stderr).toContain('body');
	expect(await readdir(join(home, 'data', 'notes'))).toEqual(before);
});

test('a second serve refuses the port and runs no app code', async () => {
	const { stderr, code } = await epicenter('serve');
	expect(code).toBe(2);
	expect(stderr).toContain('is in use');
});
