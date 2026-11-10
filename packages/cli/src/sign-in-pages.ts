/**
 * The two pages of the public sign-in (ADR-0871), rendered on the server with
 * a small inline script and no framework. WebAuthn needs the script, and
 * Better Auth takes only JSON posts with a trusted `Origin`.
 *
 * `/.sign-in` signs a person in with a passkey, registers one from an invite
 * (`?invite=`), and continues a connector's authorization when Better Auth
 * sent the browser here with its signed query. `/.allow` names the connector
 * by its metadata document's name and the host it is served from, and grants
 * reading, or reading and changing.
 *
 * Each page allows only its own script and style, cannot be framed, and sends
 * no referrer, so an invite in the address goes nowhere else.
 */
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import {
	type AuthorizationServer,
	SIGN_IN_PATH,
} from './authorization-server.ts';
import { escapeHtml } from './http.ts';

/** JSON safe to place inside a `<script>` element. */
const scriptJson = (value: unknown) =>
	JSON.stringify(value).replace(/</g, '\\u003c');

/** Base64url and WebAuthn's JSON shapes, and the JSON posts every page makes. */
const SHARED_SCRIPT = `
const page = JSON.parse(document.getElementById('page').textContent);
const status = document.getElementById('status');
const fromB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const toB64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
async function call(path, body) {
	const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(data.message || data.error_description || 'That did not work. Try again.');
	return data;
}
function busy(button, task) {
	button.addEventListener('click', async () => {
		for (const each of document.querySelectorAll('button')) each.disabled = true;
		status.textContent = '';
		try { await task(); } catch (error) {
			status.textContent = error.name === 'NotAllowedError' ? 'The passkey was not used. Try again.' : error.message;
			for (const each of document.querySelectorAll('button')) each.disabled = false;
		}
	});
}
const go = (data, fallback) => location.replace(data && data.redirect && data.url ? data.url : fallback);
`;

const SIGN_IN_SCRIPT = `
const credentialJson = (credential, response) => ({ id: credential.id, rawId: toB64(credential.rawId), type: credential.type, response, clientExtensionResults: credential.getClientExtensionResults(), authenticatorAttachment: credential.authenticatorAttachment ?? undefined });
const register = document.getElementById('register');
if (register) busy(register, async () => {
	const options = await call('/.auth/passkey/generate-register-options?context=' + encodeURIComponent(page.invite));
	const credential = await navigator.credentials.create({ publicKey: { ...options, challenge: fromB64(options.challenge), user: { ...options.user, id: fromB64(options.user.id) }, excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: fromB64(c.id) })) } });
	const { response } = credential;
	await call('/.auth/passkey/verify-registration', { createSession: true, response: credentialJson(credential, { clientDataJSON: toB64(response.clientDataJSON), attestationObject: toB64(response.attestationObject), transports: response.getTransports ? response.getTransports() : [] }) });
	location.replace(page.next);
});
const signIn = document.getElementById('sign-in');
if (signIn) busy(signIn, async () => {
	const options = await call('/.auth/passkey/generate-authenticate-options');
	const credential = await navigator.credentials.get({ publicKey: { ...options, challenge: fromB64(options.challenge), allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: fromB64(c.id) })) } });
	const { response } = credential;
	const data = await call('/.auth/passkey/verify-authentication', { ...(page.oauth ? { oauth_query: location.search.slice(1) } : {}), response: credentialJson(credential, { clientDataJSON: toB64(response.clientDataJSON), authenticatorData: toB64(response.authenticatorData), signature: toB64(response.signature), userHandle: response.userHandle ? toB64(response.userHandle) : undefined }) });
	go(data, page.next);
});
`;

const ALLOW_SCRIPT = `
for (const button of document.querySelectorAll('button[data-scope]'))
	busy(button, async () => go(await call('/.auth/oauth2/consent', { accept: true, scope: button.dataset.scope, oauth_query: location.search.slice(1) }), '/'));
busy(document.getElementById('deny'), async () => go(await call('/.auth/oauth2/consent', { accept: false, oauth_query: location.search.slice(1) }), '/'));
`;

/** A page: its title, its body, the data its script reads, and the script. */
function page(
	title: string,
	body: string,
	data: unknown = {},
	script = '',
	status = 200,
) {
	const nonce = randomBytes(16).toString('base64');
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title><style nonce="${nonce}">
:root{--bg:#fafafa;--fg:#0a0a0a;--muted:#6b6b6b;--card:#fff;--line:#e5e5e5;--accent:#0a0a0a;--on-accent:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#f5f5f5;--muted:#a0a0a0;--card:#1e1e1e;--line:#2c2c2c;--accent:#f5f5f5;--on-accent:#0a0a0a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:max(32px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
main{max-width:420px;margin:0 auto;display:grid;gap:16px}h1{font-size:26px;margin:0;letter-spacing:-.02em}p{margin:0;color:var(--muted)}
button,a.button{display:block;width:100%;padding:14px;border-radius:14px;border:1px solid var(--line);background:var(--card);color:inherit;font:inherit;font-weight:600;text-align:center;text-decoration:none;cursor:pointer}
button.primary,a.primary{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}button:disabled{opacity:.5}
#status:empty{display:none}#status{color:#c0392b}code{font-size:14px}
</style></head><body><main>${body}<p id="status" role="alert"></p></main><script type="application/json" id="page">${scriptJson(data)}</script>${script ? `<script nonce="${nonce}">${SHARED_SCRIPT}${script}</script>` : ''}</body></html>`;
	return new Response(html, {
		status,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
			'referrer-policy': 'no-referrer',
			'x-frame-options': 'DENY',
			'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
		},
	});
}

/** Where to go after signing in: a path on this origin, as a whole URL so it cannot leave it. */
function nextUrl(value: string | null, origin: string) {
	if (!value) return `${origin}/`;
	try {
		const url = new URL(value, origin);
		return url.origin === origin ? url.href : `${origin}/`;
	} catch {
		return `${origin}/`;
	}
}

/** `GET /.sign-in`: sign in with a passkey, or register one from an invite. */
export async function signInPage(
	authorization: AuthorizationServer,
	request: Request,
) {
	const { searchParams } = new URL(request.url);
	const invite = searchParams.get('invite');
	// Better Auth signs the query it sends here when an authorization needs a person.
	const oauth = searchParams.has('sig');
	const next = nextUrl(searchParams.get('next'), authorization.origin);
	const name = basename(authorization.folder);
	const session = await authorization.auth.api.getSession({
		headers: request.headers,
	});
	if (session && !oauth) {
		if (!invite)
			return new Response(null, { status: 302, headers: { location: next } });
		return page(
			'Already signed in',
			`<h1>This device is already signed in</h1><p>It does not need this invite, which stops working in 15 minutes.</p><a class="button primary" href="/">Open your apps</a>`,
		);
	}
	if (invite)
		return page(
			`Add this device to ${name}`,
			`<h1>Add this device</h1><p>This creates a passkey on this device for ${escapeHtml(name)}. You sign in with it from now on.</p><button id="register" class="primary">Create a passkey</button>`,
			{ invite, next },
			SIGN_IN_SCRIPT,
		);
	return page(
		`Sign in to ${name}`,
		`<h1>Sign in to ${escapeHtml(name)}</h1><p>Use the passkey you created on this device.</p><button id="sign-in" class="primary">Sign in with a passkey</button><p>No passkey on this device? On your computer, run <code>epicenter access invite</code> and open its link here.</p>`,
		{ oauth, next },
		SIGN_IN_SCRIPT,
	);
}

/**
 * `GET /.allow`: approve a connector. Better Auth sends the browser here, with
 * a signed query, when a signed-in person has not yet allowed the scopes a
 * connector asks for. Without a session it goes to `/.sign-in` with the same
 * query, which comes back here after a passkey.
 */
export async function allowPage(
	authorization: AuthorizationServer,
	request: Request,
) {
	const { search, searchParams } = new URL(request.url);
	const session = await authorization.auth.api.getSession({
		headers: request.headers,
	});
	if (!session)
		return new Response(null, {
			status: 302,
			headers: { location: `${SIGN_IN_PATH}${search}` },
		});
	const clientId = searchParams.get('client_id') ?? '';
	const client = authorization.db
		.query<{ name: string | null }, [string]>(
			'select name from oauthClient where clientId = ?',
		)
		.get(clientId);
	let host: string | undefined;
	try {
		host = new URL(clientId).host;
	} catch {}
	if (!client || !host)
		return page(
			'Unknown connector',
			`<h1>This connector is unknown</h1><p>Start connecting again from the app that sent you here.</p>`,
			{},
			'',
			400,
		);
	const asked = new Set((searchParams.get('scope') ?? '').split(' '));
	// A grant may only narrow what was asked; offline_access is what lets the
	// connector refresh instead of asking again every 15 minutes.
	const grant = (scopes: string[]) =>
		scopes.filter((scope) => asked.has(scope)).join(' ');
	const reading = grant(['read', 'offline_access']);
	const changing = grant(['read', 'write', 'offline_access']);
	const label = client.name ?? host;
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
		`Allow ${label}?`,
		`<h1>Allow ${escapeHtml(label)} to use your apps?</h1><p><strong>${escapeHtml(label)}</strong> (${escapeHtml(host)}) is asking to use the apps in ${escapeHtml(name)}. Reading runs only actions that change nothing.</p>${buttons}<p>You can remove it later with <code>epicenter access revoke</code> on your computer.</p>`,
		{},
		ALLOW_SCRIPT,
	);
}
