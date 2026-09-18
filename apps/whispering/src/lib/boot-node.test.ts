/**
 * The application route owns library opening. Callback routes and their
 * ancestors never import the bootstrap or acquire an App. The mounted app layout
 * calls openApplication(), which imports bootstrap.ts once. WhisperingShell
 * only consumes the opened App.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const routes = join(appRoot, 'src/routes');
const callback = join(routes, 'auth/callback/+page.svelte');

function ancestorLayouts(page: string): string[] {
	const found: string[] = [];
	for (
		let directory = dirname(page);
		directory.startsWith(routes);
		directory = dirname(directory)
	) {
		const layout = join(directory, '+layout.svelte');
		if (existsSync(layout)) found.push(layout);
	}
	return found;
}

describe('the callback opens nothing', () => {
	test('the callback page exists and has at least one ancestor layout', () => {
		expect(existsSync(callback)).toBe(true);
		expect(ancestorLayouts(callback).length).toBeGreaterThan(0);
	});

	test('callback and ancestor layouts never import the bootstrap or open a library', async () => {
		for (const file of [callback, ...ancestorLayouts(callback)]) {
			const source = await Bun.file(file).text();
			expect(source).not.toMatch(
				/(?:\$lib\/|\.\/|\.\.\/)(?:application|bootstrap)(?:\.js)?['"]/,
			);
			expect(source).not.toMatch(/openApplication\s*\(|<AppBoot\b/);
			expect(source).not.toMatch(/\.open\s*\(/);
			expect(source).not.toContain('WhisperingShell.svelte');
		}
	});

	test('the mounted app layout opens through the cached bootstrap outside callback ancestors', async () => {
		const bootNode = join(routes, '(app)/+layout.svelte');
		const source = await Bun.file(bootNode).text();
		expect(source).toContain("import('$lib/application.js')");
		expect(source).toContain('onMount(() =>');
		expect(source).toContain('<WhisperingShell ');
		expect(source).toContain(
			'openedApp={application.app} data={application.data}',
		);
		expect(source).toContain('application.app?.ready');
		expect(
			source.indexOf("import('$lib/application.js').then"),
		).toBeGreaterThan(source.indexOf('onMount(() =>'));
		expect(ancestorLayouts(callback)).not.toContain(bootNode);
		expect(source).toContain('await openApplication()');
		const application = await Bun.file(
			join(appRoot, 'src/lib/application.ts'),
		).text();
		expect(application).toContain('export function openApplication()');
		expect(application).toContain("opening ??= import('./bootstrap.js')");
		const bootstrap = await Bun.file(
			join(appRoot, 'src/lib/bootstrap.ts'),
		).text();
		expect(bootstrap).toContain('whisperingDefinition.open(account)');
	});

	test('the shell consumes the opened library without importing its bootstrap', async () => {
		const source = await Bun.file(
			join(routes, '(app)/_components/WhisperingShell.svelte'),
		).text();
		expect(source).not.toMatch(
			/(?:\$lib\/|\.\/|\.\.\/)(?:application|bootstrap)(?:\.js)?['"]/,
		);
		expect(source).not.toMatch(/openApplication\s*\(|<AppBoot\b/);
		expect(source).not.toMatch(/\.open\s*\(/);
		expect(source).toContain('= $props()');
		expect(source).toContain('fromData(data)');
	});
});
