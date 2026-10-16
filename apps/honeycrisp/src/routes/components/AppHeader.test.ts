/**
 * App Header Log Tests
 *
 * Compiles the header's actual log state and effect in a Svelte effect root.
 * Deferred Folder replies verify rerun, close/reopen and disposal ordering,
 * while the last accepted list remains visible during a new request.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommitSummary } from '@epicenter/folder';
import { flushSync } from 'svelte';
import { compileModule, parse } from 'svelte/compiler';
import { Ok } from 'wellcrafted/result';
import type { Notes } from '$lib/notes.svelte.js';

type LogReply = Awaited<ReturnType<Notes['folder']['git']['log']>>;
type Header = {
	readonly log: CommitSummary[] | string;
	open(value: boolean): void;
	changeCommit(): void;
	dispose(): void;
};

const harnessDirectory = await mkdtemp(join(import.meta.dir, '.header-log-'));
const harnessPath = join(harnessDirectory, 'header-log-effect.svelte.ts');
await Bun.write(harnessPath, '');
Bun.plugin({
	name: 'honeycrisp-header-log-test',
	setup(build) {
		build.onLoad(
			{ filter: /header-log-effect\.svelte\.ts$/ },
			async ({ path }) => {
				const source = await Bun.file(
					`${import.meta.dir}/AppHeader.svelte`,
				).text();
				const script = parse(source, { modern: true }).instance;
				if (script === null)
					throw new Error('The header has no instance script.');
				// Select production syntax, not a duplicate of its reply handling.
				const states: string[] = [];
				const effects: string[] = [];
				for (const node of script.content.body) {
					if (
						!('start' in node) ||
						typeof node.start !== 'number' ||
						!('end' in node) ||
						typeof node.end !== 'number'
					)
						throw new Error('The compiler did not provide source positions.');
					const syntax = source.slice(node.start, node.end);
					if (
						node.type === 'VariableDeclaration' &&
						node.declarations.some(
							(declaration) =>
								declaration.id.type === 'Identifier' &&
								(declaration.id.name === 'open' ||
									declaration.id.name === 'log'),
						)
					)
						states.push(syntax);
					if (
						node.type === 'ExpressionStatement' &&
						node.expression.type === 'CallExpression' &&
						node.expression.callee.type === 'Identifier' &&
						node.expression.callee.name === '$effect'
					)
						effects.push(syntax);
				}
				if (states.length !== 2 || effects.length !== 1)
					throw new Error(
						'Review the harness when the header log ownership changes.',
					);
				const generated = `
				import { getAbortSignal } from 'svelte';
				export function createHeader(read) {
					let revision = $state(0);
					const notes = {
						git: { get lastCommit() { return revision; } },
						folder: { git: { log: read } }
					};
					${states.join('\n')}
					const stop = $effect.root(() => {
						${effects[0]}
					});
					return {
						get log() { return log; },
						open(value) { open = value; },
						changeCommit() { revision += 1; },
						dispose: stop
					};
				}
			`;
				const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
					generated,
				);
				return {
					contents: compileModule(javascript, {
						filename: path,
						generate: 'client',
					}).js.code,
					loader: 'js',
				};
			},
		);
	},
});

const {
	createHeader,
}: {
	createHeader(read: (depth: number) => Promise<LogReply>): Header;
} = await import(harnessPath).finally(() =>
	rm(harnessDirectory, { recursive: true }),
);

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const stop of cleanup.splice(0)) stop();
});

function header() {
	const requests: PromiseWithResolvers<LogReply>[] = [];
	const state = createHeader((depth) => {
		expect(depth).toBe(8);
		const request = Promise.withResolvers<LogReply>();
		requests.push(request);
		return request.promise;
	});
	cleanup.push(state.dispose);
	state.open(true);
	flushSync();
	return {
		state,
		requests,
		request(index: number) {
			const request = requests[index];
			if (!request) throw new Error(`Missing log request ${index}.`);
			return request;
		},
	};
}

const commit = (oid: string): CommitSummary => ({
	oid,
	parents: [],
	message: oid,
	author: { name: 'Test', email: 'test@localhost', timestamp: 0 },
});

test('an older list cannot replace a newer reply after the effect reruns', async () => {
	const { state, requests, request } = header();
	state.changeCommit();
	flushSync();
	expect(requests).toHaveLength(2);
	request(1).resolve(Ok([commit('new')]));
	await Promise.resolve();
	expect(state.log).toEqual([commit('new')]);
	request(0).resolve(Ok([commit('old')]));
	await Promise.resolve();
	expect(state.log).toEqual([commit('new')]);
});

test('closing and reopening retains the accepted list and ignores the old error', async () => {
	const { state, requests, request } = header();
	request(0).resolve(Ok([commit('kept')]));
	await Promise.resolve();
	state.changeCommit();
	flushSync();
	state.open(false);
	flushSync();
	state.open(true);
	flushSync();
	expect(requests).toHaveLength(3);
	expect(state.log).toEqual([commit('kept')]);
	request(1).reject(new Error('old error'));
	await Promise.resolve();
	expect(state.log).toEqual([commit('kept')]);
	request(2).resolve(Ok([commit('reopened')]));
	await Promise.resolve();
	expect(state.log).toEqual([commit('reopened')]);
});

test('a reply after disposal cannot replace the last accepted list with an error', async () => {
	const { state, request } = header();
	request(0).resolve(Ok([commit('kept')]));
	await Promise.resolve();
	state.changeCommit();
	flushSync();
	state.dispose();
	request(1).reject(new Error('disposed error'));
	await Promise.resolve();
	expect(state.log).toEqual([commit('kept')]);
});
