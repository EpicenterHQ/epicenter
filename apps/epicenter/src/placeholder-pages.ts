/** Release-bundled documents for built-in routes without an app yet. */

import type { BuiltInRouteId } from './routes.ts';

type PlaceholderRouteId = Exclude<
	BuiltInRouteId,
	'home' | 'whispering' | 'honeycrisp' | 'capture' | 'mail'
>;

function placeholderPage(title: string, status: string): string {
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<meta name="color-scheme" content="light dark" />
		<title>${title} | Epicenter</title>
		<style>
			:root { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #211f1b; background: #f4f0e8; }
			body { min-height: 100vh; margin: 0; display: grid; place-items: center; }
			main { width: min(34rem, calc(100vw - 4rem)); padding: 2.5rem; border: 1px solid #d8d0c2; border-radius: 1.25rem; background: #fffdf8; box-shadow: 0 1.25rem 4rem rgb(69 56 37 / 10%); }
			p { margin: 0; color: #6a6257; line-height: 1.6; }
			.eyebrow { margin-bottom: .75rem; color: #8e5b34; font-size: .75rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
			h1 { margin: 0 0 1rem; font-size: clamp(2.25rem, 8vw, 4rem); font-weight: 650; letter-spacing: -.05em; }
			@media (prefers-color-scheme: dark) { :root { color: #f4eee4; background: #171512; } main { border-color: #3d3831; background: #211e1a; } p { color: #bdb3a5; } }
		</style>
	</head>
	<body>
		<main>
			<p class="eyebrow">Epicenter</p>
			<h1>${title}</h1>
			<p>${status}</p>
		</main>
	</body>
</html>`;
}

export const PLACEHOLDER_PAGES = {
	books: placeholderPage(
		'Books',
		'Books is coming to Epicenter. Its place is reserved, but there is nothing here yet.',
	),
} satisfies Record<PlaceholderRouteId, string>;
