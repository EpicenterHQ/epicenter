/**
 * AppBoot owns acquisition beneath the working route. Callback routes and their
 * ancestors never import the bootstrap or acquire an App. WhisperingShell passes the opened App
 * to its UI session and operations.
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
			expect(source).not.toMatch(/\bopenApp\s*\(/);
			expect(source).not.toContain('WhisperingShell.svelte');
		}
	});

	test('the page delegates acquisition to its mounted AppBoot', async () => {
		const bootNode = join(routes, '(app)/+layout.svelte');
		const source = await Bun.file(bootNode).text();
		expect(source).toContain(
			'openWhisperingResources(account, signal)',
		);
		expect(source).toContain('<WhisperingShell ');
		expect(source).not.toMatch(/openApplication|createDeparture|attachUi/);
		expect(source).not.toContain('showing');
		expect(ancestorLayouts(callback)).not.toContain(bootNode);
	});

	test('the shell consumes the opened library without importing its bootstrap', async () => {
		const source = await Bun.file(
			join(routes, '(app)/_components/WhisperingShell.svelte'),
		).text();
		expect(source).not.toMatch(/openApplication/);
		expect(source).not.toMatch(/openApplication\s*\(|<AppBoot\b/);
		expect(source).not.toMatch(/\bopenApp\s*\(/);
		expect(source).toContain('= $props()');
	});
});
