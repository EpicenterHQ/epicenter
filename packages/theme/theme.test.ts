/** Checks that the palette stays plain CSS and the Tailwind bridge maps its colors. */
import { expect, test } from 'bun:test';

const theme = await Bun.file(
	new URL('./src/theme.css', import.meta.url),
).text();
const tailwind = await Bun.file(
	new URL('./src/tailwind.css', import.meta.url),
).text();
const names = (body = '') =>
	[...body.matchAll(/--([a-z0-9-]+):/g)].map((match) => match[1]);

test('theme.css is plain CSS: custom properties under :root and .dark, and nothing else', () => {
	const css = theme.replace(/\/\*[\s\S]*?\*\//g, '');
	const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
	expect(blocks.map((block) => block[1]?.trim())).toEqual([':root', '.dark']);
	expect(css.replace(/[^{}]+\{[^{}]*\}/g, '').trim()).toBe('');
	for (const [, , body = ''] of blocks) {
		for (const declaration of body
			.split(';')
			.map((line) => line.trim())
			.filter(Boolean))
			expect(declaration).toMatch(/^--[a-z0-9-]+:\s*\S/);
	}
	const light = names(blocks[0]?.[2]);
	for (const name of names(blocks[1]?.[2])) expect(light).toContain(name);
});

test('tailwind.css maps every color in theme.css and declares none of its own', () => {
	expect(tailwind).toContain('@custom-variant dark');
	expect(tailwind).toContain('@theme inline');
	expect(tailwind).not.toContain('oklch(');
	for (const name of names(theme.match(/:root\s*\{([^}]*)\}/)?.[1])) {
		if (name !== 'radius')
			expect(tailwind).toContain(`--color-${name}: var(--${name});`);
	}
});
