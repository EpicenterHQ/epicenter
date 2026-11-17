// Platform compiler, bundled once at platform deployment. App source stays raw.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { build } from './build.js';
export class Compiler extends WorkerEntrypoint {
	async compile(
		manifest: string[],
		initial: Record<string, string>,
		reader: { read(path: string): string | null | Promise<string | null> },
	) {
		const paths = new Set(manifest);
		return build({
			read: (at) => initial[at] ?? null,
			has: (at) => paths.has(at),
			load: (at) => initial[at] ?? reader.read(at),
			list: (prefix = '') => manifest.filter((at) => at.startsWith(prefix)),
		});
	}
}
export default {
	fetch() {
		return new Response('Compiler RPC only', { status: 404 });
	},
};
