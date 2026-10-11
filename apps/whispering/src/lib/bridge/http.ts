/**
 * The page's link to the Whispering host over loopback HTTP: `fetch` against
 * the process that serves this page. The desktop shell injects the per-launch
 * token; without it the host answers nothing.
 *
 * It carries application operations, and nothing of the folder. The page's folder is the desktop shell's own, opened through
 * `@epicenter/folder/tauri`.
 */
import { decode, encode } from './codec.js';

export type BridgeConnection = {
	/** The host's origin, such as `http://127.0.0.1:49321`. */
	readonly origin: string;
	readonly token: string;
	/** Injected in tests; defaults to the page's `fetch`. */
	readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};

export type HttpBridge = {
	/** An application operation. Rejects when the host is unreachable or faults. */
	app<T>(op: string, payload?: Record<string, unknown>): Promise<T>;
};

type Reply = { ok?: unknown; fault?: string };

export function createHttpBridge({
	origin,
	token,
	fetch: send = (input, init) => fetch(input, init),
}: BridgeConnection): HttpBridge {
	const headers = {
		authorization: `Bearer ${token}`,
		'content-type': 'application/json',
	};

	return {
		async app<T>(op: string, payload: Record<string, unknown> = {}) {
			const response = await send(`${origin}/bridge/app`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ op, payload: encode(payload) }),
			});
			let reply: Reply;
			try {
				reply = (await response.json()) as Reply;
			} catch {
				throw new Error(`The Whispering host answered ${response.status}`);
			}
			if (reply.fault !== undefined) throw new Error(reply.fault);
			if (!response.ok)
				throw new Error(`The Whispering host answered ${response.status}`);
			return decode(reply.ok) as T;
		},
	};
}
