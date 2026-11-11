/**
 * The approval page (ADR-0881), on the private listener at `/.allow`, which
 * only this computer and the tailnet reach. Better Auth sends a connector's
 * authorization here from the public address with a signed query.
 *
 * `GET` names the connector first by the host its client_id is served from,
 * which no one else can claim, then by the name its metadata document gives
 * itself, and offers reading, or reading and changing. `POST` takes the
 * choice as JSON, `{ accept, scope, oauth_query }`, has the authorization
 * server answer it as the owner, and answers `{ url }`, the connector's
 * callback, where the page then goes. The private listener refuses a POST
 * whose `Origin` is another site, so only this page approves.
 *
 * The page allows only its own script and style, cannot be framed, and sends
 * no referrer.
 */
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import {
	ApprovalError,
	type AuthorizationServer,
	cleanText,
} from './authorization-server.ts';
import { escapeHtml } from './http.ts';

const SCRIPT = `
const status = document.getElementById('status');
async function answer(body) {
	for (const each of document.querySelectorAll('button')) each.disabled = true;
	status.textContent = '';
	try {
		const response = await fetch('/.allow', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, oauth_query: location.search.slice(1) }) });
		const data = await response.json().catch(() => ({}));
		if (!response.ok || !data.url) throw new Error(data.message || 'That did not work. Try again.');
		location.replace(data.url);
	} catch (error) {
		status.textContent = error.message;
		for (const each of document.querySelectorAll('button')) each.disabled = false;
	}
}
for (const button of document.querySelectorAll('button[data-scope]'))
	button.addEventListener('click', () => answer({ accept: true, scope: button.dataset.scope }));
document.getElementById('deny').addEventListener('click', () => answer({ accept: false }));
`;

/** A page: its title, its body, and whether it runs the approval script. */
function page(title: string, body: string, script: boolean, status = 200) {
	const nonce = randomBytes(16).toString('base64');
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title><style nonce="${nonce}">
:root{--bg:#fafafa;--fg:#0a0a0a;--muted:#6b6b6b;--card:#fff;--line:#e5e5e5;--accent:#0a0a0a;--on-accent:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#f5f5f5;--muted:#a0a0a0;--card:#1e1e1e;--line:#2c2c2c;--accent:#f5f5f5;--on-accent:#0a0a0a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:max(32px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
main{max-width:420px;margin:0 auto;display:grid;gap:16px}h1{font-size:26px;margin:0;letter-spacing:-.02em}p{margin:0;color:var(--muted)}
button{display:block;width:100%;padding:14px;border-radius:14px;border:1px solid var(--line);background:var(--card);color:inherit;font:inherit;font-weight:600;text-align:center;cursor:pointer}
button.primary{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}button:disabled{opacity:.5}
#status:empty{display:none}#status{color:#c0392b}code{font-size:14px}
</style></head><body><main>${body}<p id="status" role="alert"></p></main>${script ? `<script nonce="${nonce}">${SCRIPT}</script>` : ''}</body></html>`;
	return new Response(html, {
		status,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
			'referrer-policy': 'no-referrer',
			'x-frame-options': 'DENY',
			'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
		},
	});
}

/** `GET /.allow`: the connector, and the choices its authorization asked for. */
function allowPage(authorization: AuthorizationServer, request: Request) {
	const { searchParams } = new URL(request.url);
	const clientId = searchParams.get('client_id') ?? '';
	const client = authorization.db
		.query<{ name: string | null }, [string]>(
			'select name from oauthClient where clientId = ?',
		)
		.get(clientId);
	let host: string | undefined;
	try {
		host = cleanText(new URL(clientId).host);
	} catch {}
	if (!client || !host || !searchParams.has('sig'))
		return page(
			'Unknown connector',
			`<h1>This connector is unknown</h1><p>Start connecting again from the app that sent you here.</p>`,
			false,
			400,
		);
	const asked = new Set((searchParams.get('scope') ?? '').split(' '));
	// A grant may only narrow what was asked; offline_access is what lets the
	// connector refresh instead of asking again every 15 minutes, and every
	// approval keeps it.
	const grant = (scopes: string[]) =>
		scopes.filter((scope) => asked.has(scope)).join(' ');
	const reading = grant(['read', 'offline_access']);
	const changing = grant(['read', 'write', 'offline_access']);
	const calledItself = cleanText(client.name ?? '');
	const name = basename(authorization.folder);
	const buttons = [
		asked.has('write')
			? `<button class="primary" data-scope="${escapeHtml(changing)}">Allow reading and changing</button>`
			: '',
		asked.has('read')
			? `<button${asked.has('write') ? '' : ' class="primary"'} data-scope="${escapeHtml(reading)}">Allow reading only</button>`
			: '',
		`<button id="deny">Don't allow</button>`,
	].join('');
	return page(
		`Allow ${host}?`,
		`<h1>Allow ${escapeHtml(host)} to use your apps?</h1><p>A connector from <strong>${escapeHtml(host)}</strong> is asking to use the apps in ${escapeHtml(name)}${calledItself ? `. It calls itself <strong>${escapeHtml(calledItself)}</strong>` : ''}.</p><p><code>${escapeHtml(cleanText(clientId))}</code></p><p>Allow it only if you just started connecting it yourself. Reading runs the actions each app marks as read-only.</p>${buttons}<p>You can remove it later with <code>epicenter connectors revoke</code> on your computer.</p>`,
		true,
	);
}

/** `POST /.allow`: grant or refuse, and answer where the browser goes next. */
async function allowAnswer(
	authorization: AuthorizationServer,
	request: Request,
) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json(
			{ message: 'An answer is a JSON body' },
			{ status: 400 },
		);
	}
	const { accept, scope, oauth_query } = (body ?? {}) as Record<
		string,
		unknown
	>;
	if (typeof oauth_query !== 'string')
		return Response.json(
			{ message: 'This answer names no request' },
			{ status: 400 },
		);
	try {
		const url =
			accept === true
				? await authorization.approve(
						oauth_query,
						typeof scope === 'string' ? scope : '',
					)
				: await authorization.deny(oauth_query);
		return Response.json({ url }, { headers: { 'cache-control': 'no-store' } });
	} catch (error) {
		if (!(error instanceof ApprovalError)) throw error;
		return Response.json({ message: error.message }, { status: 400 });
	}
}

/** The approval page's routes, for the private listener. */
export function allowRoute(
	authorization: AuthorizationServer,
	request: Request,
) {
	if (request.method === 'GET' || request.method === 'HEAD')
		return allowPage(authorization, request);
	if (request.method === 'POST') return allowAnswer(authorization, request);
	return new Response('Method not allowed', {
		status: 405,
		headers: { allow: 'GET, HEAD, POST' },
	});
}
