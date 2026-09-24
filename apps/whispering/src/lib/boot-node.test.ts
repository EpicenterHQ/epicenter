import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const routes = fileURLToPath(new URL('../routes', import.meta.url));
const workingLayout = join(routes, '(app)/+layout.svelte');
const resourceFreePages = [
	join(routes, 'auth/callback/+page.svelte'),
	join(routes, 'auth/signout/+page.svelte'),
	join(routes, 'recovery/+page.svelte'),
];

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

describe('Whispering page ownership', () => {
	test('only the working layout opens primary resources', async () => {
		const source = await Bun.file(workingLayout).text();
		expect(source).toContain('openWhisperingResources(account, startup.signal)');
		expect(source).toContain('<WhisperingShell ');
		expect(source).toContain("window.addEventListener('pagehide', stop)");
	});

	test('callback, sign-out, and recovery are outside the working layout', async () => {
		for (const page of resourceFreePages) {
			expect(existsSync(page)).toBe(true);
			const files = [page, ...ancestorLayouts(page)];
			expect(files).not.toContain(workingLayout);
			for (const file of files) {
				const source = await Bun.file(file).text();
				expect(source).not.toContain('openWhisperingResources');
				expect(source).not.toContain('openLocalStore');
				expect(source).not.toContain('WhisperingShell.svelte');
			}
		}
	});
});
