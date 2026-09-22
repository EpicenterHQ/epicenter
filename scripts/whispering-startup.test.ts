/** Mount the actual route: signed-out startup ignores a saved remote selection. */
import { expect, test } from 'bun:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const repo = new URL('../', import.meta.url).pathname;
const requireApp = createRequire(
	new URL('../apps/whispering/package.json', import.meta.url),
);
const requireData = createRequire(
	new URL('../packages/app/package.json', import.meta.url),
);

test('mounted Whispering uses device data for every signed-out saved selection', async () => {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), 'whispering-startup-')),
	);
	const { build } = await import(requireApp.resolve('vite'));
	const { svelte } = await import(
		requireApp.resolve('@sveltejs/vite-plugin-svelte')
	);
	const { chromium } = requireData('playwright');
	const route = join(repo, 'apps/whispering/src/routes/(app)/+layout.svelte');
	await Bun.write(
		join(directory, 'index.html'),
		'<div id="app"></div><script type="module" src="/main.ts"></script>',
	);
	await Bun.write(
		join(directory, 'main.ts'),
		`import { mount, unmount } from 'svelte'; import Root from './Root.svelte'; const component = mount(Root, { target: document.querySelector('#app') }); window.stop = () => unmount(component);`,
	);
	await Bun.write(
		join(directory, 'Root.svelte'),
		`<script>import Layout from ${JSON.stringify(route)};</script><Layout><p>route child</p></Layout>`,
	);
	await Bun.write(
		join(directory, 'Shell.svelte'),
		`<script>let { openedApp, data, account } = $props();</script><p id="selection">{JSON.stringify({ device: data === openedApp.local, account: account === undefined })}</p>`,
	);
	await Bun.write(join(directory, 'Menu.svelte'), '<span>Library menu</span>');
	await Bun.write(
		join(directory, 'auth.ts'),
		`export const auth = { getState: () => ({ status: 'signed-out' }), onStateChange: () => () => {}, signOut: async () => ({error:null}) };`,
	);
	await Bun.write(
		join(directory, 'data.ts'),
		`import { defineApp } from ${JSON.stringify(join(repo, 'packages/app/src/index.ts'))}; export const whisperingDefinition = defineApp({ id: 'test.whispering-startup', tables: {}, kv: {} });`,
	);
	await build({
		configFile: false,
		root: directory,
		plugins: [
			{
				name: 'startup-fixture',
				enforce: 'pre',
				transform(code: string, id: string) {
					if (id !== route) return;
					return code
						.replace(
							"import { resolve } from '$app/paths';",
							'const resolve = (path) => path;',
						)
						.replace(
							"from '#platform/auth'",
							`from ${JSON.stringify(join(directory, 'auth.ts'))}`,
						)
						.replace(
							"from '$lib/data.js'",
							`from ${JSON.stringify(join(directory, 'data.ts'))}`,
						)
						.replace(
							"from './_components/WhisperingShell.svelte'",
							`from ${JSON.stringify(join(directory, 'Shell.svelte'))}`,
						)
						.replace(
							"from '$lib/components/LibrarySelection.svelte'",
							`from ${JSON.stringify(join(directory, 'Menu.svelte'))}`,
						)
						.replace(
							'<script lang="ts">',
							`<script lang="ts">import { createMemoryStoreRuntime } from ${JSON.stringify(join(repo, 'packages/app/src/testing.ts'))}; const runtime = createMemoryStoreRuntime();`,
						)
						.replace(
							"import { openWhisperingResources } from '$lib/whispering/resources.js';",
							`import { openLocal } from ${JSON.stringify(join(repo, 'packages/app/src/open.ts'))}; import { whisperingDefinition } from ${JSON.stringify(join(directory, 'data.ts'))}; const openWhisperingResources = async () => ({local:await openLocal(whisperingDefinition,{runtime}), close:async()=>{}, signal:new AbortController().signal});`,
						);
				},
			},
			svelte({ configFile: false }),
		],
		resolve: {
			dedupe: ['svelte'],
			alias: Object.entries(requireApp('svelte/package.json').exports).flatMap(
				([key, entry]) => {
					const value = entry as
						| string
						| { browser?: string; default?: string };
					const target =
						typeof value === 'string'
							? value
							: (value.browser ?? value.default);
					return target
						? [
								{
									find: new RegExp(
										`^${key === '.' ? 'svelte' : `svelte/${key.slice(2)}`}$`,
									),
									replacement: join(
										dirname(requireApp.resolve('svelte/package.json')),
										target,
									),
								},
							]
						: [];
				},
			),
		},
		build: { target: 'esnext', outDir: join(directory, 'dist') },
		logLevel: 'error',
	});
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			return new Response(
				Bun.file(join(directory, 'dist', path === '/' ? 'index.html' : path)),
			);
		},
	});
	let browser;
	try {
		browser = await chromium.launch({ headless: true });
		for (const saved of [null, 'local', 'personal']) {
			const page = await browser.newPage();
			const errors: string[] = [];
			page.on('pageerror', (error: Error) => errors.push(error.message));
			page.on('console', (message: { type(): string; text(): string }) => {
				if (message.type() === 'error') errors.push(message.text());
			});
			page.on(
				'requestfailed',
				(request: { url(): string; failure(): { errorText: string } | null }) =>
					errors.push(request.url() + ': ' + request.failure()?.errorText),
			);
			await page.addInitScript((value: string | null) => {
				if (value !== null) localStorage.setItem('whispering.library', value);
			}, saved);
			await page.goto(server.url.toString());
			await page
				.locator('#selection')
				.waitFor({ timeout: 10000 })
				.catch(async (cause: unknown) => {
					throw new Error(
						JSON.stringify({
							errors,
							body: await page.locator('body').innerText(),
						}),
						{ cause },
					);
				});
			expect(JSON.parse(await page.locator('#selection').innerText())).toEqual({
				device: true,
				account: true,
			});
			expect(
				await page.evaluate(() => localStorage.getItem('whispering.library')),
			).toBe(saved);
			await page.evaluate('window.stop()');
			expect(errors).toEqual([]);
			await page.close();
		}
	} finally {
		await browser?.close();
		server.stop(true);
		await rm(directory, { recursive: true, force: true });
	}
}, 60000);
