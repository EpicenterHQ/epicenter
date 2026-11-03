// Static SPA server: serves a build directory, answers unknown paths with index.html.
import { join } from 'node:path';

const dir = process.argv[2] as string;
const port = Number(process.argv[3] ?? 5199);
Bun.serve({
	port,
	hostname: 'localhost',
	async fetch(req) {
		const path = decodeURIComponent(new URL(req.url).pathname);
		const file = Bun.file(join(dir, path));
		if (path !== '/' && (await file.exists())) return new Response(file);
		return new Response(Bun.file(join(dir, 'index.html')), {
			headers: { 'content-type': 'text/html' },
		});
	},
});
console.log(`serving ${dir} on ${port}`);
