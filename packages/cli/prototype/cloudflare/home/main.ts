import {
	type Account,
	createBrowserOAuth,
	epicenterCloud,
} from '../../../../account/src/index.ts';
import { runAddress } from '../src/access.ts';

declare const HOME_API_ORIGIN: string;
const apiOrigin = HOME_API_ORIGIN;
const resource = apiOrigin + '/homes';
const auth = createBrowserOAuth({
	server: epicenterCloud(apiOrigin),
	clientId: 'so.epicenter.home',
	grant: () => ({
		resources: [resource],
		scope:
			'openid profile email home:read home:source home:build home:run home:manage',
	}),
	accountManagement: true,
});
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
	document.getElementById(id) as T;
const message = (id: string, value = '') => {
	el(id).textContent = value;
};
let owner: Account | undefined;
let revision = '';
let saved = '';
let openedFile = 'epicenter.ts';
let sourceRequest = 0;
let selectedRun: { id: string; action: string } | undefined;
let observer: AbortController | undefined;
let framePort: MessagePort | undefined;
let disconnectFrame: (() => void) | undefined;
let appRequest = 0;
let frameRequests = new Map<number, AbortController>();
async function api(path: string, body?: unknown, method?: string) {
	const own = owner;
	if (!own) throw new Error('Sign in to open your home.');
	const response = await own.fetch(resource + path, {
		method: method ?? (body === undefined ? 'GET' : 'POST'),
		...(body === undefined
			? {}
			: {
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
				}),
	});
	const value: any = response.status === 204 ? null : await response.json();
	own.signal.throwIfAborted();
	if (!response.ok)
		throw new Error(value.error?.message ?? value.error ?? 'Request failed');
	return value;
}
function report(error: unknown) {
	if (owner && !owner.signal.aborted)
		message('error', error instanceof Error ? error.message : String(error));
}
function task(fn: () => Promise<unknown>) {
	return () => {
		message('error');
		void fn().catch(report);
	};
}
function closeFrame(clear = true) {
	if (clear) appRequest++;
	disconnectFrame?.();
	disconnectFrame = undefined;
	framePort?.close();
	framePort = undefined;
	for (const controller of frameRequests.values()) controller.abort();
	frameRequests = new Map();
	if (clear) document.querySelector('iframe')!.srcdoc = '';
}
// The frame receives bytes and a run-only port. It never receives an OAuth token.
const frameBridge = (
	base: string,
	nonce: string,
) => `window.__EPICENTER_APP_URL__=${JSON.stringify(base)};
let port;const ready=new Promise(resolve=>{const listen=e=>{if(e.source===parent&&e.data?.type==='epicenter-runs'&&e.data.nonce===${JSON.stringify(nonce)}&&e.ports[0]){removeEventListener('message',listen);port=e.ports[0];resolve();}};addEventListener('message',listen);parent.postMessage({type:'epicenter-ready',nonce:${JSON.stringify(nonce)}},'*');});
let next=0;window.fetch=async(input,init={})=>{await ready;const req=new Request(input,init);const id=++next;const channel=new MessageChannel();let control;let started=false;const stream=new ReadableStream({start(c){control=c},cancel(){port.postMessage({id,cancel:true});channel.port1.close()}});return new Promise(async(resolve,reject)=>{channel.port1.onmessage=({data:d})=>{if(d.error){started?control.error(new Error(d.error)):reject(new Error(d.error));channel.port1.close();return}if(d.status){started=true;resolve(new Response(stream,{status:d.status,headers:d.headers}));}if(d.chunk)control.enqueue(d.chunk);if(d.end){control.close();channel.port1.close();}};req.signal.addEventListener('abort',()=>{port.postMessage({id,cancel:true});control.error(new DOMException('Aborted','AbortError'));channel.port1.close();reject(new DOMException('Aborted','AbortError'));},{once:true});port.postMessage({id,url:req.url,method:req.method,body:req.method==='GET'?undefined:await req.text()},[channel.port2]);});};`;
async function openApp() {
	const own = owner!;
	const generation = ++appRequest;
	const preview = await api('/admin/preview');
	if (generation !== appRequest) return;
	own.signal.throwIfAborted();
	revision = preview.revision;
	closeFrame(false);
	const frame = document.querySelector('iframe')!;
	const base = `https://app.invalid/tasks~${revision}/`;
	const nonce = crypto.randomUUID();
	const channel = new MessageChannel();
	framePort = channel.port1;
	const requests = frameRequests;
	channel.port1.onmessage = ({ data, ports }) => {
		if (data.cancel) {
			requests.get(data.id)?.abort();
			return;
		}
		const reply = ports[0];
		void (async () => {
			const url = new URL(data.url);
			const run = runAddress(url.pathname);
			if (
				url.origin !== 'https://app.invalid' ||
				!url.pathname.startsWith(`/tasks~${preview.revision}/`) ||
				!run ||
				!['GET', 'POST'].includes(data.method)
			)
				throw new Error('App frames can only call their published actions.');
			const abort = new AbortController();
			requests.set(data.id, abort);
			try {
				const response = await own.fetch(resource + url.pathname + url.search, {
					method: data.method,
					signal: abort.signal,
					headers:
						data.method === 'POST'
							? { 'content-type': 'application/json' }
							: {},
					...(data.method === 'POST' ? { body: data.body } : {}),
				});
				own.signal.throwIfAborted();
				reply.postMessage({
					status: response.status,
					headers: [...response.headers],
				});
				const reader = response.body?.getReader();
				if (reader)
					try {
						while (true) {
							const { value, done } = await reader.read();
							if (done) break;
							reply.postMessage({ chunk: value });
						}
					} finally {
						await reader.cancel().catch(() => {});
					}
				reply.postMessage({ end: true });
			} finally {
				requests.delete(data.id);
			}
		})()
			.catch((e) => reply.postMessage({ error: String(e) }))
			.finally(() => reply.close());
	};
	const css = preview.css.replace(
		/url\(["']?\.\/fonts\/([^)'"\s]+)["']?\)/g,
		(_: string, name: string) =>
			`url(data:font/woff2;base64,${preview.fonts['/fonts/' + name] ?? ''})`,
	);
	let connected = false;
	const ready = (event: MessageEvent) => {
		if (
			connected ||
			generation !== appRequest ||
			event.source !== frame.contentWindow ||
			event.data?.type !== 'epicenter-ready' ||
			event.data.nonce !== nonce
		)
			return;
		connected = true;
		frame.contentWindow!.postMessage({ type: 'epicenter-runs', nonce }, '*', [
			channel.port2,
		]);
	};
	addEventListener('message', ready);
	disconnectFrame = () => {
		removeEventListener('message', ready);
		channel.port2.close();
	};
	const encode = (text: string) =>
		btoa(String.fromCharCode(...new TextEncoder().encode(text)));
	// Chunk-free base64 conversion for the large bundle.
	const js64 = btoa(
		Array.from(new TextEncoder().encode(preview.js), (c) =>
			String.fromCharCode(c),
		).join(''),
	);
	frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline'; font-src data:; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'"><style>${css.replaceAll('</style', '<\\/style')}</style><script src="data:text/javascript;base64,${encode(frameBridge(base, nonce))}"></script></head><body><script type="module" src="data:text/javascript;base64,${js64}"></script></body></html>`;
	await refreshStatus();
}
async function refreshStatus() {
	const status = await api('/admin/status');
	revision = status.active;
	message(
		'version',
		`Tasks · published ${revision?.slice(0, 8) ?? 'not yet'} · private to your account`,
	);
	return status;
}
async function openFile(path: string) {
	const request = ++sourceRequest;
	const value = await api('/admin/source?path=' + encodeURIComponent(path));
	if (request !== sourceRequest) return;
	const files = el<HTMLSelectElement>('files');
	files.replaceChildren(...value.paths.map((p: string) => new Option(p, p)));
	if (!value.paths.includes(path)) files.add(new Option(path, path));
	files.value = openedFile = path;
	el<HTMLTextAreaElement>('code').value = saved = value.text ?? '';
}
async function save() {
	const path = openedFile,
		text = el<HTMLTextAreaElement>('code').value;
	await api('/admin/source', { files: { [path]: text } });
	if (openedFile === path) saved = text;
	message('notice', 'Draft saved.');
}
async function build() {
	const button = el<HTMLButtonElement>('build');
	button.disabled = true;
	try {
		if (el<HTMLTextAreaElement>('code').value !== saved) await save();
		message('build-result', 'Building in Workers…');
		const result = await api('/admin/build', {});
		message('build-result', `Published ${result.id}\n${result.compiler}`);
		await openApp();
	} catch (e) {
		message(
			'build-result',
			`Build failed. Your published app is still available.\n${e instanceof Error ? e.message : String(e)}`,
		);
		await refreshStatus();
	} finally {
		button.disabled = false;
	}
}
async function refreshRuns() {
	const rows = await api('/admin/runs');
	el('run-list').replaceChildren(
		...rows.map((r: any) => {
			const row = document.createElement('div');
			row.className = 'run';
			const b = document.createElement('button');
			b.textContent = `${r.action} · ${r.state} · ${r.id.slice(0, 8)}`;
			b.onclick = task(() => follow(r));
			row.append(b);
			return row;
		}),
	);
}
async function follow(row: { id: string; action: string }, start?: unknown) {
	observer?.abort();
	const own = owner!;
	const controller = new AbortController();
	observer = controller;
	selectedRun = row;
	el('cancel-run').hidden = false;
	message('events');
	const response = await own.fetch(
		resource +
			`/.runs/tasks/${row.action}/${row.id}` +
			(start === undefined ? '/events' : ''),
		{
			method: start === undefined ? 'GET' : 'POST',
			signal: controller.signal,
			...(start === undefined
				? {}
				: {
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(start),
					}),
		},
	);
	if (!response.ok) throw new Error(await response.text());
	const reader = response
		.body!.pipeThrough(new TextDecoderStream())
		.getReader();
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			el('events').textContent += value;
		}
	} finally {
		reader.releaseLock();
	}
	if (!own.signal.aborted) await refreshRuns();
}
async function refreshGrants() {
	const grants = await api('/agents');
	el('grants').replaceChildren(
		...grants.map((g: any) => {
			const row = document.createElement('div');
			row.className = 'grant';
			const text = document.createElement('span');
			text.textContent = `Agent connected ${new Date(g.created_at).toLocaleString()} · ${g.scopes.join(', ')} · expires ${new Date(g.expires_at).toLocaleString()}`;
			row.append(text);
			{
				const b = document.createElement('button');
				b.textContent = 'Revoke';
				b.onclick = task(async () => {
					await api('/agents/' + encodeURIComponent(g.id), undefined, 'DELETE');
					await refreshGrants();
				});
				row.append(b);
			}
			return row;
		}),
	);
	if (!grants.length) message('grants', 'No agents have access.');
}
el('login').onclick = task(async () => {
	const result = await auth.startSignIn();
	if (result.error) throw new Error(result.error.message);
});
el('signout').onclick = task(async () => {
	closeFrame();
	observer?.abort();
	await auth.signOut();
	location.replace('/');
});
for (const button of document.querySelectorAll<HTMLButtonElement>(
	'[data-view]',
))
	button.onclick = task(async () => {
		for (const id of ['app', 'edit', 'activity', 'agents'])
			el(id).hidden = id !== button.dataset.view;
		for (const b of document.querySelectorAll('[data-view]'))
			b.setAttribute('aria-pressed', String(b === button));
		if (
			button.dataset.view === 'edit' &&
			!el<HTMLSelectElement>('files').options.length
		)
			await openFile('epicenter.ts');
		if (button.dataset.view === 'activity') await refreshRuns();
		if (button.dataset.view === 'agents') await refreshGrants();
	});
el('files').onchange = task(async () => {
	if (
		el<HTMLTextAreaElement>('code').value !== saved &&
		!confirm('Discard this unsaved draft?')
	) {
		el<HTMLSelectElement>('files').value = openedFile;
		return;
	}
	await openFile(el<HTMLSelectElement>('files').value);
});
el('save').onclick = task(save);
el('build').onclick = task(build);
el('refresh-runs').onclick = task(refreshRuns);
el('start-review').onclick = task(() =>
	follow(
		{ id: crypto.randomUUID(), action: 'review' },
		{ key: crypto.randomUUID(), steps: 40, delayMs: 1000 },
	),
);
el('cancel-run').onclick = task(async () => {
	if (selectedRun)
		await api(
			`/.runs/tasks/${selectedRun.action}/${selectedRun.id}/cancel`,
			{},
		);
});
el('grant-form').onsubmit = (e) => {
	e.preventDefault();
	task(async () => {
		const own = owner!;
		const scopes = [
			...document.querySelectorAll<HTMLInputElement>(
				'[name=permission]:checked',
			),
		].map((e) => e.value);
		if (!scopes.length) throw new Error('Choose at least one permission.');
		const button = el<HTMLButtonElement>('connect-agent');
		button.disabled = true;
		try {
			const response = await fetch(apiOrigin + '/auth/device/code', {
				method: 'POST',
				credentials: 'omit',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					client_id: 'so.epicenter.home.agent',
					scope: scopes.join(' '),
					resource,
				}),
			});
			const device: any = await response.json();
			if (!response.ok)
				throw new Error(
					device.error_description ?? 'Could not start agent approval.',
				);
			own.signal.throwIfAborted();
			const approval = el('device-approval');
			approval.replaceChildren();
			const link = document.createElement('a');
			link.textContent = `Approve connection: ${device.user_code}`;
			link.href =
				apiOrigin + '/device?user_code=' + encodeURIComponent(device.user_code);
			link.target = '_blank';
			link.rel = 'noopener noreferrer';
			approval.append(link);
			const expires = Date.now() + device.expires_in * 1000;
			let interval = Math.max(device.interval ?? 5, 5) * 1000;
			while (Date.now() < expires) {
				await new Promise<void>((resolve, reject) => {
					const abort = () => {
						clearTimeout(timer);
						reject(new DOMException('Aborted', 'AbortError'));
					};
					const timer = setTimeout(() => {
						own.signal.removeEventListener('abort', abort);
						resolve();
					}, interval);
					own.signal.addEventListener('abort', abort, { once: true });
				});
				own.signal.throwIfAborted();
				const redeemed = await fetch(apiOrigin + '/auth/oauth2/token', {
					method: 'POST',
					credentials: 'omit',
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams({
						client_id: 'so.epicenter.home.agent',
						grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
						device_code: device.device_code,
						resource,
					}),
					signal: own.signal,
				});
				const tokens: any = await redeemed.json();
				if (tokens.error === 'authorization_pending') continue;
				if (tokens.error === 'slow_down') {
					interval += 5000;
					continue;
				}
				if (!redeemed.ok)
					throw new Error(
						tokens.error_description ??
							tokens.error ??
							'Agent approval failed.',
					);
				own.signal.throwIfAborted();
				message('device-approval', 'Agent approved.');
				el('new-grant').hidden = false;
				el<HTMLTextAreaElement>('credential').value =
					`Base URL: ${resource}\nAuthorization: Bearer ${tokens.access_token}\nApp: tasks\nScopes: ${scopes.join(' ')}\nRead/edit: GET/POST /admin/source\nBuild: POST /admin/build\nRun: POST /.runs/tasks/<action>/<new-run-id>\nObserve: GET /.runs/tasks/<action>/<run-id>/events\nCancel: POST /.runs/tasks/<action>/<run-id>/cancel`;
				await refreshGrants();
				return;
			}
			throw new Error('The approval code expired. Connect the agent again.');
		} finally {
			button.disabled = false;
		}
	})();
};
el('forget-grant').onclick = () => {
	el<HTMLTextAreaElement>('credential').value = '';
	el('new-grant').hidden = true;
};
function reconcile() {
	const state = auth.state();
	if (state.status === 'reauth-required') {
		message('error', 'Sign in again to reconnect your home.');
		el('signin').hidden = false;
		return;
	}
	if (state.account === owner) return;
	observer?.abort();
	closeFrame();
	owner = state.account;
	selectedRun = undefined;
	revision = '';
	saved = '';
	sourceRequest++;
	for (const id of ['app', 'edit', 'activity', 'agents'])
		el(id).hidden = id !== 'app';
	for (const b of document.querySelectorAll<HTMLButtonElement>('[data-view]'))
		b.setAttribute('aria-pressed', String(b.dataset.view === 'app'));
	el<HTMLTextAreaElement>('code').value = '';
	el<HTMLSelectElement>('files').replaceChildren();
	el<HTMLTextAreaElement>('credential').value = '';
	el('new-grant').hidden = true;
	for (const id of [
		'run-list',
		'grants',
		'events',
		'version',
		'notice',
		'error',
		'build-result',
		'device-approval',
	])
		el(id).textContent = '';
	el('workspace').hidden = !owner;
	el('signin').hidden = !!owner;
	el('signout').hidden = !owner;
	if (!owner) {
		el<HTMLTextAreaElement>('credential').value = '';
		return;
	}
	const own = owner;
	void (async () => {
		const profile = await own.getProfile();
		own.signal.throwIfAborted();
		message('identity', profile.data?.email ?? 'Your private hosted home');
		message('notice', 'Opening your home…');
		await api('/provision', {});
		await openApp();
		message('notice');
	})().catch(report);
}
if (location.pathname === '/auth/callback') {
	const result = await auth.completeSignIn();
	if (result.error) message('error', result.error.message);
	else location.replace(result.data.returnTo ?? '/');
} else {
	auth.subscribe(reconcile);
	await auth.refresh();
	reconcile();
}

window.addEventListener('beforeunload', (event) => {
	if (owner && el<HTMLTextAreaElement>('code').value !== saved) {
		event.preventDefault();
		event.returnValue = '';
	}
});
