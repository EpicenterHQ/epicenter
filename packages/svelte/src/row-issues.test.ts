/** Row issue rendering keeps each diagnostic visible with its location. */
import './svelte-dom.test-support.js';
import { expect, test } from 'bun:test';

const { flushSync, mount, unmount } = await import('svelte');
const { default: RowIssues } = await import('./row-issues.svelte');

test('RowIssues renders each formatted issue as a list item', async () => {
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(RowIssues, {
		target,
		props: {
			issues: [
				{ kind: 'schema', line: 2, path: ['title'], message: 'Required' },
				{ kind: 'frontmatter', path: [], message: 'Invalid YAML' },
			],
		},
	});
	flushSync();
	expect(
		[...target.querySelectorAll('li')].map((item) => item.textContent),
	).toEqual(['Line 2: title: Required', 'Invalid YAML']);
	await unmount(view);
	target.remove();
});
