// Local black-box acceptance: real OAuth + Postgres + two workerd processes.
// Only social-provider sign-in is replaced by a signed test session in a private DB.
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { migrate } from '../../../server/node_modules/drizzle-orm/node-postgres/migrator';
import { createDb } from '../../../server/src/db/create-db.ts';
import { startDisposablePostgres } from '../../../server/src/test-helpers/disposable-postgres.ts';
import { OAuthTestClient } from '../../../server/src/test-helpers/oauth-client.ts';
import { chromium } from 'playwright';
import { sources, seed, api } from './source.ts';
const root = import.meta.dir;
const repo = resolve(root, '../../../..');
const apiOrigin = 'http://localhost:8787';
const homeOrigin = 'http://localhost:8799';
const resource = apiOrigin + '/homes';
const secret = 'hosted-proof-only-secret-01234567890123456789';
const report = { started: new Date().toISOString(), checks: [] as string[] };
function check(value: unknown, label: string) {
	assert(value, label);
	report.checks.push(label);
	console.log('PASS ' + label);
}
const cluster = await startDisposablePostgres();
const [sql] = cluster.clients;
const children: Bun.Subprocess[] = [];
const scratch = await mkdtemp(join(tmpdir(), 'epicenter-hosted-proof-'));
const configs = [join(scratch, 'api.json'), join(scratch, 'home.json')];
const workerName = 'hosted-home-proof-' + crypto.randomUUID();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
async function ready(url: string) {
	for (let n = 0; n < 120; n++) {
		try {
			const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
			if (r.status < 500) return;
		} catch {}
		await Bun.sleep(500);
	}
	throw new Error('Worker did not start: ' + url);
}
try {
	await migrate(createDb(sql), {
		migrationsFolder: join(repo, 'apps/api/drizzle'),
	});
	const platformToken = crypto.randomUUID() + crypto.randomUUID();
	process.env.TASKS_PROTOTYPE_TOKEN = platformToken;
	const config = Bun.JSONC.parse(
		await Bun.file(join(repo, 'apps/api/wrangler.jsonc')).text(),
	) as Record<string, any>;
	await Bun.write(
		configs[0],
		JSON.stringify({
			...config,
			name: workerName + '-api',
			main: join(repo, 'apps/api/worker/index.ts'),
			assets: { ...config.assets, directory: join(repo, 'apps/api/ui/build') },
			routes: [],
			build: undefined,
			vars: { API_PUBLIC_ORIGIN: apiOrigin, HOSTED_HOMES_EXPERIMENT: 'on' },
			services: [
				{
					binding: 'HOSTED_HOMES',
					service: workerName,
					entrypoint: 'HomeGateway',
				},
			],
		}),
	);
	const homeConfig = Bun.JSONC.parse(
		await Bun.file(join(root, 'wrangler.jsonc')).text(),
	) as Record<string, any>;
	await Bun.write(
		configs[1],
		JSON.stringify({
			...homeConfig,
			name: workerName,
			main: join(root, 'src/worker.ts'),
			vars: {
				API_ORIGIN: apiOrigin,
				ADMIN_TOKEN: platformToken,
				TEST_INTERRUPTION: 'true',
			},
		}),
	);
	await Bun.write('/tmp/epicenter-hosted-proof.log', '');
	await chmod('/tmp/epicenter-hosted-proof.log', 0o600);
	const logs = Bun.file('/tmp/epicenter-hosted-proof.log').writer();
	// Logs stay local, including any auth diagnostic from the disposable service.
	for (const [file, port] of [
		[configs[1], '8799'],
		[configs[0], '8787'],
	] as const) {
		const child = Bun.spawn(
			[
				process.execPath,
				'x',
				'wrangler',
				'dev',
				'--config',
				file,
				'--port',
				port,
			],
			{
				cwd: root,
				env: {
					...process.env,
					BETTER_AUTH_SECRET: secret,
					GOOGLE_CLIENT_ID: 'test-local',
					GOOGLE_CLIENT_SECRET: 'test-local',
					GITHUB_CLIENT_ID: 'test-local',
					GITHUB_CLIENT_SECRET: 'test-local',
					MICROSOFT_CLIENT_ID: 'test-local',
					MICROSOFT_CLIENT_SECRET: 'test-local',
					OPENAI_API_KEY: 'test-local',
					GEMINI_API_KEY: 'test-local',
					AUTUMN_SECRET_KEY: 'test-local',
					CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: `postgresql://postgres:disposable-test-only@127.0.0.1:${cluster.port}/postgres`,
				},
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		children.push(child);
		for (const stream of [child.stdout, child.stderr])
			void (async () => {
				for await (const chunk of stream as ReadableStream<Uint8Array>) {
					logs.write(chunk);
					await logs.flush();
				}
			})();
		await ready(port === '8799' ? homeOrigin + '/health' : apiOrigin + '/');
	}
	if (process.env.HOSTED_PROOF_PROTOCOL) {
		const protocol = Bun.spawn(
			[process.execPath, 'prove.ts', homeOrigin + '/platform/template'],
			{ cwd: root, env: process.env, stdout: 'inherit', stderr: 'inherit' },
		);
		assert.equal(await protocol.exited, 0);
	}
	await seed(homeOrigin + '/platform/template');
	const starter = await api(
		homeOrigin + '/platform/template',
		'/admin/build',
		{},
	);
	if (!starter.response.ok)
		console.log('Starter build failed', starter.response.status, starter.value);
	check(starter.response.ok, 'Starter compiles once inside Workers');
	const oauth = new OAuthTestClient(apiOrigin, sql, secret);
	const a = await oauth.person('Alice');
	const b = await oauth.person('Bob');
	const ownerScopes =
		'openid profile email home:read home:source home:build home:run home:manage';
	const token = async (person: typeof a) =>
		oauth.codeGrant({
			clientId: 'so.epicenter.home',
			redirectUri: homeOrigin + '/auth/callback',
			cookie: person.cookie,
			scope: ownerScopes,
			resource: [resource],
		});
	const at = await token(a);
	const bt = await token(b);
	async function request(
		token: string,
		path: string,
		body?: unknown,
		method?: string,
	) {
		return fetch(resource + path, {
			method: method ?? (body === undefined ? 'GET' : 'POST'),
			headers: {
				authorization: 'Bearer ' + token,
				...(body === undefined ? {} : { 'content-type': 'application/json' }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	}
	check(
		(await request(at.access_token, '/provision', {})).ok &&
			(await request(bt.access_token, '/provision', {})).ok,
		'Two OAuth principals provision separate homes',
	);
	const dataA = (await (
		await request(at.access_token, '/admin/data')
	).json()) as any[];
	check(
		dataA.length === 0,
		'Starter copies code and build, never template task data',
	);
	const as = (await (
		await request(at.access_token, '/admin/status')
	).json()) as any;
	const bs = (await (
		await request(bt.access_token, '/admin/status')
	).json()) as any;
	check(
		as.active === bs.active,
		'Both homes start on one precompiled starter revision',
	);
	check(
		(await fetch(resource + '/admin/status')).status === 401,
		'Missing token is refused',
	);
	check(
		(await fetch(resource + '/admin/status', { headers: { cookie: a.cookie } }))
			.status === 401,
		'Sign-in cookie alone cannot authorize home resources',
	);
	check(
		(
			await fetch(homeOrigin + '/admin/source', {
				headers: { authorization: 'Bearer ' + platformToken },
			})
		).status === 401,
		'Old shared key cannot access personal home code',
	);
	const wrong = await oauth.codeGrant({
		clientId: 'so.epicenter.todos',
		redirectUri: 'http://localhost:5186/auth/callback',
		cookie: a.cookie,
		scope: 'openid folders:read',
		resource: [apiOrigin + '/folders'],
	});
	check(
		(await request(wrong.access_token, '/admin/status')).status === 401,
		'Another resource audience cannot enter hosted homes',
	);
	const scoped = await oauth.deviceGrant({
		clientId: 'so.epicenter.home.agent',
		cookie: a.cookie,
		scope: 'home:read home:source',
		resource: [resource],
	});
	assert(scoped.tokens);
	check(
		!scoped.tokens.refresh_token,
		'Agent approval issues an expiring access token without a refresh credential',
	);
	const original = (await (
		await request(at.access_token, '/admin/source?path=epicenter.ts')
	).json()) as any;
	check(
		(
			await request(scoped.tokens.access_token, '/admin/source', {
				files: { 'epicenter.ts': original.text + '\n// private Alice draft\n' },
			})
		).ok,
		'Source-only agent edits its person’s draft',
	);
	check(
		(await request(scoped.tokens.access_token, '/admin/build', {})).status ===
			403 &&
			(
				await request(
					scoped.tokens.access_token,
					'/.runs/tasks/list/scoped-run',
					{},
				)
			).status === 403,
		'Source permission cannot publish or run actions',
	);
	check(
		(
			await request(
				scoped.tokens.access_token,
				'/.runs/tasks/review/nonexistent/events',
			)
		).status === 404,
		'Read-only grant can inspect run events without execution permission',
	);
	check(
		(await request(scoped.tokens.access_token, '/agents')).status === 403,
		'Agent cannot manage agent credentials',
	);
	const bsource = (await (
		await request(bt.access_token, '/admin/source?path=epicenter.ts')
	).json()) as any;
	check(
		!bsource.text.includes('private Alice draft'),
		'Source edits stay in the authenticated person’s home',
	);
	const spoofed = (await (
		await fetch(
			resource + '/admin/source?path=epicenter.ts&principal=' + b.id,
			{
				headers: {
					authorization: 'Bearer ' + at.access_token,
					'x-epicenter-principal': b.id,
				},
			},
		)
	).json()) as any;
	check(
		spoofed.text.includes('private Alice draft'),
		'Caller-supplied principal headers and query cannot switch homes',
	);
	const grants = (await (
		await request(at.access_token, '/agents')
	).json()) as any[];
	const grant = grants.find((g) => g.scopes.includes('home:source'));
	check(
		grant && !('token' in grant),
		'Owner can list agent grants without revealing credentials',
	);
	await request(bt.access_token, '/agents/' + grant.id, undefined, 'DELETE');
	check(
		(await request(scoped.tokens.access_token, '/admin/status')).ok,
		'Another account cannot revoke this person’s agent',
	);
	await request(at.access_token, '/agents/' + grant.id, undefined, 'DELETE');
	check(
		(await request(scoped.tokens.access_token, '/admin/status')).status === 401,
		'Revocation blocks the very next agent request',
	);
	const full = await oauth.deviceGrant({
		clientId: 'so.epicenter.home.agent',
		cookie: a.cookie,
		scope: 'home:read home:source home:build home:run',
		resource: [resource],
	});
	assert(full.tokens);
	const agent = full.tokens.access_token;
	async function run(
		token: string,
		action: string,
		input: unknown,
		id = crypto.randomUUID(),
	) {
		const response = await request(
			token,
			`/.runs/tasks/${action}/${id}`,
			input,
		);
		assert(response.ok, await response.clone().text());
		const events = (await response.text())
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		assert.equal(events.at(-1).type, 'finished');
		assert.equal(events.at(-1).answer.error, null);
		return { id, events, value: events.at(-1).answer.data };
	}
	const a1 = await run(agent, 'module-counter', {}),
		a2 = await run(agent, 'module-counter', {}),
		b1 = await run(bt.access_token, 'module-counter', {});
	check(
		a1.value.calls === 1 && a2.value.calls === 2 && b1.value.calls === 1,
		'Homes on the same starter revision do not share mutable JavaScript module state',
	);
	const added = await run(agent, 'add', {
		title: 'Only Alice can see this task',
		notes: 'private Markdown',
	});
	const alist = await run(at.access_token, 'list', {});
	const blist = await run(bt.access_token, 'list', {});
	check(
		alist.value.length === 1 && blist.value.length === 0,
		'Agent-written Markdown data stays in one home',
	);
	check(
		(await request(bt.access_token, `/.runs/tasks/add/${added.id}`)).status ===
			404,
		'Run history is isolated between people',
	);
	const reviewId = crypto.randomUUID(),
		key = crypto.randomUUID();
	const pending = await request(agent, `/.runs/tasks/review/${reviewId}`, {
		key,
		steps: 8,
		delayMs: 200,
	});
	const reader = pending.body!.getReader();
	await reader.read();
	await reader.cancel();
	await Bun.sleep(2200);
	const replay = await request(agent, `/.runs/tasks/review/${reviewId}/events`);
	const events = (await replay.text())
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));
	check(
		events.at(-1).type === 'finished' &&
			events.filter((e) => e.type === 'started').length === 1,
		'Disconnect through OAuth gateway preserves one execution and replays events',
	);
	const cancelId = crypto.randomUUID(),
		cancelKey = crypto.randomUUID();
	const cancelRun = await request(agent, `/.runs/tasks/review/${cancelId}`, {
		key: cancelKey,
		steps: 40,
		delayMs: 150,
	});
	const cancelReader = cancelRun.body!.getReader();
	await cancelReader.read();
	await cancelReader.cancel();
	await Bun.sleep(450);
	check(
		(await request(agent, `/.runs/tasks/review/${cancelId}/cancel`, {})).ok,
		'Agent can cancel an accepted action through the gateway',
	);
	await Bun.sleep(300);
	const cancelled = (await (
		await request(agent, '/admin/data')
	).json()) as any[];
	const cancelledEffects = JSON.parse(
		cancelled.find((r) => r.path === `data/reviews/${cancelKey}.json`).text,
	);
	await Bun.sleep(450);
	const later = (await (await request(agent, '/admin/data')).json()) as any[];
	check(
		cancelledEffects.effects < 40 &&
			JSON.parse(
				later.find((r) => r.path === `data/reviews/${cancelKey}.json`).text,
			).effects === cancelledEffects.effects,
		'Cancellation fences further stored effects',
	);
	await request(agent, '/admin/source', {
		files: { 'ui/src/main.ts': 'this is a broken Svelte entrypoint !' },
	});
	check(
		(await request(agent, '/admin/build', {})).status === 422,
		'Agent receives a build diagnostic for broken code',
	);
	const afterBad = (await (
		await request(at.access_token, '/admin/status')
	).json()) as any;
	check(
		afterBad.active === as.active,
		'Broken build leaves the last working UI and actions published',
	);
	const raw = await sources();
	await request(agent, '/admin/source', {
		files: { 'ui/src/main.ts': raw.files['ui/src/main.ts'] },
	});
	await request(agent, '/admin/source', {
		files: {
			'review.prototype.ts': raw.files['review.prototype.ts'].replace(
				'calls: ++moduleCalls',
				'calls: 100 + ++moduleCalls',
			),
			'ui/src/pages/List.svelte': raw.files['ui/src/pages/List.svelte'].replace(
				/>\s*Tasks\s*</,
				'>Hosted Tasks<',
			),
		},
	});
	const rebuilt = await request(agent, '/admin/build', {});
	check(rebuilt.ok, 'Agent can build edited source entirely inside Workers');
	check(
		(await run(agent, 'module-counter', {})).value.calls === 101,
		'Published actions execute the agent’s edited TypeScript',
	);
	const bobAfter = (await (
		await request(bt.access_token, '/admin/status')
	).json()) as any;
	check(
		bobAfter.active === bs.active,
		'Publishing in one home leaves another home on its own version',
	);
	const illegalRefresh = await oauth.token({
		client_id: 'so.epicenter.home.agent',
		grant_type: 'refresh_token',
		refresh_token: 'not-a-token',
	});
	check(
		illegalRefresh.status !== 200,
		'Agent client refuses the refresh grant',
	);
	for (const denied of ['offline_access', 'home:manage', 'folders:all']) {
		const response = await oauth.request('/auth/device/code', {
			form: {
				client_id: 'so.epicenter.home.agent',
				scope: 'home:read ' + denied,
				resource,
			},
		});
		const body = (await response.json()) as any;
		check(
			!response.ok && body.error === 'invalid_scope',
			'Agent device request cannot acquire ' + denied,
		);
	}
	// Actual browser client follows authorize -> callback -> token -> Account.fetch.
	browser = await chromium.launch({
		headless: true,
		executablePath: process.env.CHROMIUM_EXECUTABLE,
	});
	const context = await browser.newContext({
		viewport: { width: 1440, height: 1000 },
	});
	const [cookieName, cookieValue] = a.cookie.split('=');
	await context.addCookies([
		{
			name: cookieName,
			value: decodeURIComponent(cookieValue),
			url: apiOrigin,
			httpOnly: true,
			sameSite: 'Lax',
		},
	]);
	const page = await context.newPage();
	const errors: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error')
			console.log('Browser console:', message.text().slice(0, 1800));
	});
	page.on('pageerror', (error) => {
		errors.push(error.message);
		console.log('Browser error:', error.message);
	});
	await page.goto(homeOrigin);
	await page.getByRole('button', { name: 'Sign in to Epicenter' }).click();
	await page.waitForURL(homeOrigin + '/', { timeout: 30000 });
	await page.locator('#workspace').waitFor({ state: 'visible' });
	await page
		.locator('#version')
		.filter({ hasText: 'published' })
		.waitFor({ timeout: 30000 });
	const frame = page.frameLocator('iframe');
	await frame
		.getByText('Only Alice can see this task', { exact: true })
		.waitFor({ timeout: 15000 });
	check(
		true,
		'Existing browser OAuth client signs in and loads private Svelte Tasks',
	);
	const isolated = await page
		.frames()
		.find((f) => f.parentFrame())!
		.evaluate(async () => {
			let parentBlocked = false,
				storageBlocked = false,
				adminBlocked = false;
			try {
				void parent.document.body;
			} catch {
				parentBlocked = true;
			}
			try {
				localStorage.getItem('token');
			} catch {
				storageBlocked = true;
			}
			try {
				await fetch('https://app.invalid/admin/source');
			} catch {
				adminBlocked = true;
			}
			let traversalBlocked = false,
				deleteBlocked = false;
			const base = (window as any).__EPICENTER_APP_URL__;
			try {
				await fetch(base + '.runs/tasks/x/%2e%2e/%2e%2e/%2e%2e/admin/build', {
					method: 'POST',
					body: '{}',
				});
			} catch {
				traversalBlocked = true;
			}
			try {
				await fetch(base + '.runs/tasks/list/test', { method: 'DELETE' });
			} catch {
				deleteBlocked = true;
			}
			return {
				parentBlocked,
				storageBlocked,
				adminBlocked,
				traversalBlocked,
				deleteBlocked,
			};
		});
	check(
		isolated.parentBlocked &&
			isolated.storageBlocked &&
			isolated.adminBlocked &&
			isolated.traversalBlocked &&
			isolated.deleteBlocked,
		'Editable UI cannot read parent credentials, storage, or management routes',
	);
	const csp = await page
		.frames()
		.find((f) => f.parentFrame())!
		.evaluate(
			async ({ apiOrigin, homeOrigin }) => {
				const blocked = (url: string) =>
					new Promise<boolean>((resolve) => {
						const xhr = new XMLHttpRequest();
						xhr.timeout = 2000;
						xhr.onload = () => resolve(false);
						xhr.onerror = () => resolve(true);
						xhr.ontimeout = () => resolve(false);
						xhr.open('GET', url);
						xhr.send();
					});
				return {
					api: await blocked(apiOrigin + '/homes/admin/status'),
					shell: await blocked(homeOrigin + '/health'),
				};
			},
			{ apiOrigin, homeOrigin },
		);
	check(
		csp.api && csp.shell,
		'Frame CSP blocks native network requests to the real API and shell origins',
	);

	await page.screenshot({
		path: join(root, 'evidence/hosted-home.png'),
		fullPage: true,
	});
	await frame
		.getByRole('textbox', { name: 'New task', exact: true })
		.fill('Task from the isolated Svelte UI');
	await frame.getByRole('button', { name: 'Add task', exact: true }).click();
	await frame
		.getByText('Task from the isolated Svelte UI', { exact: true })
		.waitFor();
	check(true, 'Isolated Svelte UI can run actions and render their saved data');
	await page.getByRole('button', { name: 'Edit code', exact: true }).click();
	await page.waitForFunction(
		() => !!(document.getElementById('code') as HTMLTextAreaElement)?.value,
	);
	await page.screenshot({
		path: join(root, 'evidence/hosted-editor.png'),
		fullPage: true,
	});

	const editorSource = await page.locator('#code').inputValue();
	const workingRevision = (
		(await (await request(at.access_token, '/admin/status')).json()) as any
	).active;
	await page.locator('#code').fill('export const broken = ;');
	await page
		.getByRole('button', { name: 'Build and publish', exact: true })
		.click();
	await page
		.locator('#build-result')
		.filter({ hasText: 'Build failed.' })
		.waitFor({ timeout: 30000 });
	check(
		((await (await request(at.access_token, '/admin/status')).json()) as any)
			.active === workingRevision,
		'Trusted editor keeps the published app after its broken build',
	);
	await page.screenshot({
		path: join(root, 'evidence/hosted-broken-build.png'),
		fullPage: true,
	});
	await page.locator('#code').fill(editorSource);
	await page.getByRole('button', { name: 'Save draft', exact: true }).click();
	await page.locator('#notice').filter({ hasText: 'Draft saved.' }).waitFor();
	await page.getByRole('button', { name: 'Agent access', exact: true }).click();
	await page.locator('#grants .grant').first().waitFor();
	await page.screenshot({
		path: join(root, 'evidence/hosted-agents.png'),
		fullPage: true,
	});
	await page
		.getByRole('button', { name: 'Connect an agent', exact: true })
		.click();
	const approvalLink = page.locator('#device-approval a');
	await approvalLink.waitFor();
	const popupPromise = context.waitForEvent('page');
	await approvalLink.click();
	const approvalPage = await popupPromise;
	await approvalPage
		.getByRole('button', { name: 'Approve', exact: true })
		.click();
	await page
		.locator('#new-grant')
		.waitFor({ state: 'visible', timeout: 20000 });
	const connection = await page.locator('#credential').inputValue();
	check(
		connection.includes('Bearer ep_at_'),
		'Home dashboard completes existing device approval and reveals the agent credential once',
	);
	await page.getByRole('button', { name: 'Hide credential' }).click();
	check(
		(await page.locator('#credential').inputValue()) === '',
		'Hiding a grant clears its credential from the dashboard',
	);
	await approvalPage.close();
	await page.getByRole('button', { name: 'Activity', exact: true }).click();
	await page
		.getByRole('button', { name: 'Start a review', exact: true })
		.click();
	await page.waitForFunction(() =>
		document.getElementById('events')?.textContent?.includes('yielded'),
	);
	const running = (await (
		await request(at.access_token, '/admin/runs')
	).json()) as any[];
	const browserRun = running.find(
		(r) => r.action === 'review' && r.state === 'running',
	);
	assert(browserRun);
	await page.close();
	await Bun.sleep(33000);
	const reopened = await context.newPage();
	await reopened.goto(homeOrigin);
	await reopened.locator('#workspace').waitFor({ state: 'visible' });
	await reopened.getByRole('button', { name: 'Activity', exact: true }).click();
	await reopened
		.getByRole('button', {
			name: new RegExp('review.*' + browserRun.id.slice(0, 8)),
		})
		.click();
	await reopened.waitForFunction(
		() => document.getElementById('events')?.textContent?.includes('finished'),
		{},
		{ timeout: 20000 },
	);
	const browserData = (await (
		await request(at.access_token, '/admin/data')
	).json()) as any[];
	const browserEvents = await (
		await request(
			at.access_token,
			`/.runs/tasks/review/${browserRun.id}/events`,
		)
	).text();
	check(
		browserEvents.match(/"type":"started"/g)?.length === 1,
		'Closing the actual page for over thirty seconds preserves one execution and reconnect replays it',
	);
	await reopened.screenshot({
		path: join(root, 'evidence/hosted-replay.png'),
		fullPage: true,
	});
	await reopened.setViewportSize({ width: 390, height: 844 });
	await reopened.getByRole('button', { name: 'Tasks', exact: true }).click();
	await reopened
		.frameLocator('iframe')
		.getByText('Only Alice can see this task', { exact: true })
		.waitFor();
	await reopened.screenshot({
		path: join(root, 'evidence/hosted-mobile.png'),
		fullPage: true,
	});
	check(
		errors.length === 0,
		'Trusted shell and isolated app have no uncaught browser errors',
	);
	await context.close();
	const expired = await oauth.deviceGrant({
		clientId: 'so.epicenter.home.agent',
		cookie: a.cookie,
		scope: 'home:read',
		resource: [resource],
	});
	assert(expired.tokens);
	await sql.query(
		"update oauth_access_token set expires_at=now() at time zone 'UTC' - interval '1 second' where client_id='so.epicenter.home.agent' and user_id=$1",
		[a.id],
	);
	check(
		(await request(expired.tokens.access_token, '/admin/status')).status ===
			401,
		'Expired agent credentials cannot reach the home',
	);
	await Bun.write(
		join(root, 'proof-hosted-local.json'),
		JSON.stringify(report, null, 2) + '\n',
	);
} catch (error) {
	if (browser)
		for (const ctx of browser.contexts())
			for (const page of ctx.pages())
				await page
					.screenshot({
						path: join(root, 'evidence/hosted-failure.png'),
						fullPage: true,
					})
					.catch(() => {});
	throw error;
} finally {
	await browser?.close();
	for (const child of children) child.kill('SIGTERM');
	await Promise.all(children.map((child) => child.exited));
	await rm(scratch, { recursive: true, force: true });
	await cluster.stop();
}
