/**
 * Starter palette tests
 *
 * `init` writes `starter/theme.css` into a new home, and `packages/ui` styles
 * this repository's own interfaces with `styles/theme.css`. Both are the
 * Graphite + blue palette. The command keeps its own copy so the published
 * package carries no private one, which leaves two files that can drift
 * apart without anyone deciding they should.
 *
 * Key behaviors:
 * - The starter palette is byte for byte the palette packages/ui uses
 */
import { expect, test } from 'bun:test';

test('the starter theme.css is identical to the packages/ui palette', async () => {
	const starter = Bun.file(new URL('./theme.css', import.meta.url));
	const ui = Bun.file(
		new URL('../../../ui/src/styles/theme.css', import.meta.url),
	);
	// Change both files together; a deliberate difference replaces this test.
	expect(await starter.text()).toBe(await ui.text());
});
