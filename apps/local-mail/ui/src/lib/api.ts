import type { ApiApp } from '@epicenter/local-mail/http/api';
import { hc } from 'hono/client';

// The same-origin `/api` client, typed end to end by `hc<ApiApp>`: its request
// and response shapes are inferred from the Hono routes in
// `apps/local-mail/src/http/api.ts`, so the wire contract cannot drift from the
// server. The per-launch local API bearer is handed to the SPA by the runtime
// host as a `window.__LOCAL_MAIL__` global, injected into the served HTML before
// this code runs (prod: the Bun loopback host; later: the Tauri host's init
// script). It is a loopback credential, never a Gmail token, and it never rides
// the URL. In dev there is no global: the Vite proxy injects the host's bearer on
// each proxied `/api` request instead, so `readBearer()` returns null and this
// module attaches nothing (the proxy authenticates).

declare global {
	interface Window {
		__LOCAL_MAIL__?: { origin?: string; bearer: string };
	}
}

function readBearer(): string | null {
	if (typeof window === 'undefined') return null;
	return window.__LOCAL_MAIL__?.bearer ?? null;
}

// Every hc request routes through this: attach the per-launch bearer from the
// injected global. Typed with an explicit signature rather than `typeof fetch`
// so it does not have to restate Bun's `fetch.preconnect`.
const authedFetch = async (
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> => {
	const headers = new Headers(init?.headers);
	const bearer = readBearer();
	if (bearer) headers.set('authorization', `Bearer ${bearer}`);
	return fetch(input, { ...init, headers });
};

// Same-origin: hc needs an absolute base for URL construction, and this module
// only ever executes in the browser (the SPA is `ssr: false`, `prerender:
// false`). The localhost fallback keeps a stray import from throwing at load.
const base =
	typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
const client = hc<ApiApp>(base, { fetch: authedFetch });

async function toError(res: Response): Promise<Error> {
	// Errors arrive as wellcrafted's envelope `{ data: null, error: { name,
	// message, status } }` from the `/api` app's `defineErrors` variants.
	const body = (await res.json().catch(() => null)) as {
		error?: { message?: string };
	} | null;
	return new Error(body?.error?.message ?? `Request failed (${res.status}).`);
}

type MessageQuery = {
	label?: string;
	search?: string;
	limit?: number;
	offset?: number;
};

// Every read/write is account-scoped: the host serves all connected mailboxes
// under one origin (`/api/accounts/:account/*`), and the caller (the page's
// account switcher) passes which one. `accounts()` lists the connected set.
export const api = {
	accounts: async () => {
		const res = await client.api.accounts.$get();
		if (!res.ok) throw await toError(res);
		return res.json();
	},
	status: async (account: string) => {
		const res = await client.api.accounts[':account'].status.$get({
			param: { account },
		});
		if (!res.ok) throw await toError(res);
		return res.json();
	},
	labels: async (account: string) => {
		const res = await client.api.accounts[':account'].labels.$get({
			param: { account },
		});
		if (!res.ok) throw await toError(res);
		return res.json();
	},
	messages: async (account: string, query: MessageQuery = {}) => {
		const res = await client.api.accounts[':account'].messages.$get({
			param: { account },
			query: {
				...(query.label ? { label: query.label } : {}),
				...(query.search ? { q: query.search } : {}),
				...(query.limit != null ? { limit: String(query.limit) } : {}),
				...(query.offset != null ? { offset: String(query.offset) } : {}),
			},
		});
		if (!res.ok) throw await toError(res);
		return res.json();
	},
	message: async (account: string, id: string) => {
		const res = await client.api.accounts[':account'].messages[':id'].$get({
			param: { account, id },
		});
		if (!res.ok) throw await toError(res);
		return res.json();
	},
	reconcile: async (account: string) => {
		const res = await client.api.accounts[':account'].reconcile.$post({
			param: { account },
		});
		if (!res.ok) throw await toError(res);
		return res.json();
	},
	/** Record a triage act. It is durable and visible to the very next read
	 * before this resolves; the host's reconciler delivers it to Gmail. */
	assert: async (
		account: string,
		input: {
			ids: string[];
			addLabels?: string[];
			removeLabels?: string[];
		},
	) => {
		const res = await client.api.accounts[':account'].messages.assert.$post({
			param: { account },
			json: input,
		});
		if (!res.ok) throw await toError(res);
		return res.json();
	},
};
