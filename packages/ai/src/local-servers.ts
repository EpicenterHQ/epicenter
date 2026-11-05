import { isTauri } from '@tauri-apps/api/core';
import { createLogger } from 'wellcrafted/logger';
import { createClient } from './client.js';
import {
	type Endpoint,
	type EndpointModel,
	guessCapabilities,
	openAiCompatible,
} from './endpoint.js';

const log = createLogger('ai/local-servers');

/** The shell's fetch with no key, its code loaded with the first request. */
const shellFetch = async (input: string, init?: RequestInit) =>
	(await import('./tauri.js')).shellFetch(input, init);

/** The model servers people run on their own computer, at their default ports. */
const SERVERS = [
	{ id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
	{ id: 'lm-studio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
] as const;

/**
 * Ollama and LM Studio on this computer, one endpoint each. Neither lists a
 * model until a probe of its `models` finds the server; a probe that no
 * longer finds it lists none again, and either change tells subscribers.
 *
 * A probe runs in the background and never blocks: when the first
 * subscriber arrives (a picker shown), on `refresh()` (a picker opened, a
 * sync), and every `interval` milliseconds while subscribed when one is
 * given. A server that has not answered in `timeout` milliseconds counts as
 * absent. Only this computer is probed; a server elsewhere is a `custom`
 * endpoint.
 *
 * In a browser a probe is the tab's own `fetch`, and finds a server only
 * when it allows this origin. In a Tauri window it is the shell's fetch
 * with no key (`shellFetch`, loaded with the first probe), since neither
 * server answers a `tauri://` page.
 */
export function localServers({
	fetch = isTauri() ? shellFetch : globalThis.fetch.bind(globalThis),
	timeout = 2000,
	interval,
}: {
	fetch?: (input: string, init?: RequestInit) => Promise<Response>;
	timeout?: number;
	interval?: number;
} = {}): Endpoint[] {
	return SERVERS.map((server) => {
		let models: readonly EndpointModel[] = [];
		let probing: AbortController | undefined;
		let timer: ReturnType<typeof setInterval> | undefined;
		const listeners = new Set<() => void>();
		const endpoint = openAiCompatible({
			...server,
			source: 'local',
			fetch,
			models: () => models,
		});
		const client = createClient(endpoint);

		function settle(found: readonly string[]) {
			const same =
				found.length === models.length &&
				found.every((id, index) => models[index]?.id === id);
			if (same) return;
			models = found.map((id) => ({ id, can: guessCapabilities(id) }));
			for (const listener of [...listeners]) {
				try {
					listener();
				} catch (cause) {
					log.error(new Error('A local server subscriber failed.', { cause }));
				}
			}
		}

		async function probe() {
			// The newest probe decides; an older one still in flight is dropped.
			probing?.abort();
			const attempt = new AbortController();
			probing = attempt;
			const signal = AbortSignal.any([
				attempt.signal,
				AbortSignal.timeout(timeout),
			]);
			// A fetch that ignores its signal still counts as absent at the timeout.
			const gaveUp = new Promise<null>((resolve) =>
				signal.addEventListener('abort', () => resolve(null), { once: true }),
			);
			const answer = await Promise.race([
				client.listModels({ signal }),
				gaveUp,
			]);
			if (probing !== attempt) return;
			probing = undefined;
			settle(answer?.data ?? []);
		}

		return {
			...endpoint,
			subscribe(listener) {
				listeners.add(listener);
				if (listeners.size === 1) {
					void probe();
					if (interval !== undefined)
						timer = setInterval(() => void probe(), interval);
				}
				return () => {
					if (!listeners.delete(listener) || listeners.size > 0) return;
					clearInterval(timer);
					timer = undefined;
				};
			},
			refresh: probe,
		};
	});
}
