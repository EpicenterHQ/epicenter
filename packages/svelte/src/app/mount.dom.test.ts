/**
 * Svelte App Adapter DOM Tests
 *
 * Mounts a root through `mountSvelte`, as the shell mounts an app, over a
 * stand-in repository.
 *
 * Key behaviors:
 * - The root shows the path it was mounted at, and `setPath` moves it in place
 * - `navigate` reaches the shell as the root called it
 * - The repository's reads are tracked: a status change redraws the root
 * - `unmount` removes everything the app rendered
 */
import '../svelte-dom.test-support.js';
import { expect, test } from 'bun:test';
import type { AppManifest } from '@epicenter/app';
import type {
	Repository,
	RepositoryChange,
	RepositoryStatus,
} from '@epicenter/repository';

const { flushSync } = await import('svelte');
const { mountSvelte } = await import('./mount.svelte.js');
const { default: PathRoot } = await import('../fixtures/PathRoot.svelte');

/** A repository with no collections whose status the test sets. */
function standIn() {
	let status: RepositoryStatus = { status: 'opening' };
	const listeners = new Set<(change: RepositoryChange) => void>();
	const repo = {
		status: () => status,
		revision: () => 0,
		subscribe(listener: (change: RepositoryChange) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	} as unknown as Repository<AppManifest['collections']['definitions']>;
	return {
		repo,
		set(next: RepositoryStatus) {
			status = next;
			for (const listener of listeners)
				listener({ collections: [], files: false, status: true });
		},
	};
}

test('a root mounted through the adapter follows its path, navigates, tracks the repository, and unmounts', async () => {
	const target = document.createElement('div');
	document.body.append(target);
	const asked: [string, { replace?: boolean } | undefined][] = [];
	const { repo, set } = standIn();
	const mounted = mountSvelte<AppManifest>(PathRoot)(target, {
		repo,
		path: '/milk',
		navigate: async (path, options) => {
			asked.push([path, options]);
		},
	});
	flushSync();
	const shown = target.querySelector('[data-testid="path"]');
	expect(shown?.textContent).toBe('/milk');

	mounted.setPath?.('/bread?x=1');
	flushSync();
	expect(target.querySelector('[data-testid="path"]')).toBe(shown);
	expect(shown?.textContent).toBe('/bread?x=1');

	target.querySelector('button')?.click();
	expect(asked).toEqual([['/next', { replace: true }]]);

	expect(target.querySelector('[data-testid="status"]')?.textContent).toBe(
		'opening',
	);
	set({ status: 'open' });
	flushSync();
	expect(target.querySelector('[data-testid="status"]')?.textContent).toBe(
		'open',
	);

	await mounted.unmount();
	expect(target.querySelector('[data-testid="path"]')).toBeNull();
	target.remove();
});
