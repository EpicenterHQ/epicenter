/** Build the real shared account menu independently of an application's store. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

export async function createAccountPopoverFixture(getConfiguration) {
	const output = await mkdtemp(join(tmpdir(), 'epicenter-account-menu-'));
	await build({
		configFile: false,
		root: fileURLToPath(new URL('.', import.meta.url)),
		plugins: [svelte({ configFile: false }), tailwindcss()],
		logLevel: 'error',
		build: { outDir: output, emptyOutDir: true, target: 'esnext' },
	});
	const server = Bun.serve({
		hostname: 'localhost',
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === '/fixture/config')
				return Response.json(await getConfiguration());
			const file = Bun.file(
				join(output, path.startsWith('/assets/') ? path : 'index.html'),
			);
			return new Response(file);
		},
	});
	return {
		origin: server.url.origin,
		async close() {
			await server.stop(true);
			await rm(output, { recursive: true, force: true });
		},
	};
}
