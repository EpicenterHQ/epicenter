/** Disposable end-to-end Capture proof with two signed-in browser replicas. */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
import type { PlatformProxy } from 'wrangler';

const { getPlatformProxy }: typeof import('wrangler') = createRequire(
	new URL('../../self-host/package.json', import.meta.url),
)('wrangler');
const root = join(import.meta.dir, '../../..');
const temporary = mkdtempSync(join(tmpdir(), 'capture-smoke-'));

async function freeOrigin() {
	const server = Bun.serve({
		hostname: 'localhost',
		port: 0,
		fetch: () => new Response(),
	});
	const origin = server.url.origin;
	await server.stop(true);
	return origin;
}

const issuer = await freeOrigin();
const app = await freeOrigin();
const workerConfig = join(temporary, 'worker.json');
const operatorConfig = join(temporary, 'operator.json');
const viteConfig = join(temporary, 'vite.config.mts');
const workerName = `capture-smoke-${crypto.randomUUID()}`;
writeFileSync(
	viteConfig,
	`import config from ${JSON.stringify(join(root, 'apps/capture/vite.config.ts'))};\nexport default { ...config, server: { ...config.server, watch: null, hmr: false } };\n`,
);
writeFileSync(
	workerConfig,
	JSON.stringify({
		name: workerName,
		main: join(root, 'apps/self-host/worker/index.ts'),
		compatibility_date: '2026-03-06',
		compatibility_flags: ['nodejs_compat'],
		send_metrics: false,
		vars: {
			API_PUBLIC_ORIGIN: issuer,
			SELF_HOST_CALLBACKS: JSON.stringify([`${app}/auth/callback`]),
			TRUSTED_BROWSER_ORIGINS: app,
		},
		durable_objects: {
			bindings: [
				{ name: 'SELF_HOST_AUTH', class_name: 'SelfHostAuthOwner' },
				{ name: 'STORE_AUTHORITY', class_name: 'StoreAuthority' },
				{ name: 'GENERATIONS_LEDGER', class_name: 'GenerationsLedger' },
			],
		},
		migrations: [
			{
				tag: 'smoke',
				new_sqlite_classes: [
					'SelfHostAuthOwner',
					'StoreAuthority',
					'GenerationsLedger',
				],
			},
		],
	}),
);
writeFileSync(
	operatorConfig,
	JSON.stringify({
		name: 'capture-smoke-operator',
		compatibility_date: '2026-03-06',
		send_metrics: false,
		services: [
			{
				binding: 'OPERATOR',
				service: workerName,
				entrypoint: 'SelfHostOperator',
				remote: false,
			},
		],
	}),
);

const children: ChildProcess[] = [];
const logs: string[] = [];
function start(args: string[], env: NodeJS.ProcessEnv = {}, cwd = root) {
	const child = spawn(process.execPath, args, {
		cwd,
		detached: true,
		env: {
			...process.env,
			...env,
			PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
			WRANGLER_SEND_METRICS: 'false',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	child.stdout.on('data', (chunk) => logs.push(String(chunk)));
	child.stderr.on('data', (chunk) => logs.push(String(chunk)));
	children.push(child);
	return child;
}

const worker = start(
	[
		'x',
		'--no-install',
		'wrangler',
		'dev',
		'--local',
		'--config',
		workerConfig,
		'--port',
		new URL(issuer).port,
		'--inspector-port',
		'0',
		'--persist-to',
		join(temporary, 'worker-state'),
	],
	{},
	join(root, 'apps/self-host'),
);
const vite = start(
	[
		'dev:capture:ui',
		'--config',
		viteConfig,
		'--port',
		new URL(app).port,
		'--strictPort',
	],
	{
		VITE_EPICENTER_SERVER: issuer,
	},
);

async function ready(url: string, child: ChildProcess) {
	for (let attempt = 0; attempt < 200; attempt++) {
		try {
			if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
		} catch {}
		assert.equal(child.exitCode, null, `${url} exited`);
		await Bun.sleep(100);
	}
	throw new Error(`Timed out starting ${url}`);
}

type Operator = {
	admit(input: { id: string; name: string }): Promise<{ url: string }>;
};
let proxy: PlatformProxy<{ OPERATOR: Operator }> | undefined;
let browser: Browser | undefined;
const errors: string[] = [];

async function signIn(page: Page) {
	await page.goto(app);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.waitForURL(app);
	await page.getByRole('heading', { name: 'Timeline' }).waitFor();
}

try {
	await Promise.all([ready(issuer, worker), ready(app, vite)]);
	proxy = await getPlatformProxy<{ OPERATOR: Operator }>({
		configPath: operatorConfig,
		persist: false,
		remoteBindings: false,
	});
	browser = await chromium.launch({ headless: true });
	const grant = await proxy.env.OPERATOR.admit({
		id: 'capture-disposable',
		name: 'Capture Test',
	});
	const firstContext = await browser.newContext();
	const first = await firstContext.newPage();
	first.on('pageerror', (error) => errors.push(`first: ${error.message}`));
	const cdp = await firstContext.newCDPSession(first);
	await cdp.send('WebAuthn.enable');
	await cdp.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	});
	await first.goto(grant.url);
	await first.click('#continue');
	await first.waitForFunction(
		() => document.querySelector('h1')?.textContent === 'You are signed in',
	);

	const secondContext = await browser.newContext();
	await secondContext.addCookies(await firstContext.cookies(issuer));
	const second = await secondContext.newPage();
	second.on('pageerror', (error) => errors.push(`second: ${error.message}`));
	await Promise.all([signIn(first), signIn(second)]);

	await first.getByLabel('Capture a thought').fill('Root one');
	await first.getByRole('button', { name: 'Add entry' }).click();
	const rootUrl = first.url();
	const rootId = new URL(rootUrl).searchParams.get('entry');
	assert(rootId, 'creation must open the minted entry');
	await first.getByLabel('Entry text').pressSequentially(' typed');
	await first.getByLabel('Entry text').blur();
	await second.getByText('Root one typed', { exact: true }).waitFor();

	await first.getByLabel('Add a reply').fill('Level one');
	await first.getByRole('button', { name: 'Add reply' }).click();
	await first.getByLabel('Add a reply').fill('Level two');
	await first.getByRole('button', { name: 'Add reply' }).click();
	await first.getByLabel('Add a reply').fill('Level three');
	await first.getByRole('button', { name: 'Add reply' }).click();
	assert.equal(
		await first
			.getByRole('navigation', { name: 'Breadcrumb' })
			.getByRole('button')
			.count(),
		4,
	);
	await first.getByRole('status').getByText('Saved on this device').waitFor();
	await first.reload();
	await first.getByLabel('Entry text').waitFor();
	assert.equal(
		await first.getByLabel('Entry text').inputValue(),
		'Level three',
	);
	await second.goto(rootUrl);
	await second.getByLabel('Entry text').waitFor();
	assert.equal(
		await second.getByLabel('Entry text').inputValue(),
		'Root one typed',
	);
	await second.getByText('Level one', { exact: true }).click();
	await second.getByText('Level two', { exact: true }).click();
	await second.getByText('Level three', { exact: true }).click();
	assert.equal(
		await second.getByLabel('Entry text').inputValue(),
		'Level three',
	);
	await second.getByRole('button', { name: 'Capture' }).click();
	await second.getByLabel('Capture a thought').fill('Root two');
	await second.getByRole('button', { name: 'Add entry' }).click();
	const secondRootUrl = second.url();
	const secondRootId = new URL(secondRootUrl).searchParams.get('entry');
	assert(secondRootId);
	await first.getByRole('button', { name: 'Capture' }).click();
	const timeline = first.getByLabel('Timeline entries').getByRole('button');
	await timeline.first().getByText('Root two').waitFor();
	await timeline.nth(1).getByText('Root one typed').waitFor();
	await first.goto(secondRootUrl);
	await first.getByRole('button', { name: 'Move', exact: true }).click();
	await first.getByLabel('Move destination').selectOption(rootId);
	await first.getByRole('button', { name: 'Move entry' }).click();
	await second.goto(rootUrl);
	await second.getByLabel('Replies').getByText('Root two', { exact: true }).waitFor();
	await first.goto(rootUrl);
	await first.getByRole('button', { name: 'Delete entry…' }).click();
	await second.getByLabel('Entry text').pressSequentially('!');
	await first.getByText('This subtree changed. Review the updated list before deleting.').waitFor();
	await first.getByRole('button', { name: 'I reviewed the changes' }).click();
	await first.getByRole('button', { name: 'Cancel' }).click();
	await second.getByLabel('Entry text').press('Backspace');

	// The second replica creates a child the confirming replica never sees.
	await secondContext.setOffline(true);
	await second.getByLabel('Replies').getByText('Root two', { exact: true }).click();
	await second.getByLabel('Entry text').pressSequentially(' edited offline');
	await second.getByLabel('Entry text').blur();
	await second.getByRole('button', { name: 'Move', exact: true }).click();
	await second.getByLabel('Move destination').selectOption('');
	await second.getByRole('button', { name: 'Move entry' }).click();
	await second.getByRole('button', { name: 'Capture' }).click();
	await second.getByLabel('Timeline entries').getByText('Root one typed', { exact: true }).click();
	await second.getByLabel('Add a reply').fill('Unseen reply');
	await second.getByRole('button', { name: 'Add reply' }).click();
	await second.getByRole('button', { name: 'Capture' }).click();
	await first.goto(rootUrl);
	await first.getByRole('button', { name: 'Delete entry…' }).click();
	await first.getByRole('region', { name: 'Delete preview' }).getByText('Permanently delete 5 entries?').waitFor();
	await first.getByRole('button', { name: 'Permanently delete' }).click();
	await first.getByRole('heading', { name: 'Timeline' }).waitFor();
	await secondContext.setOffline(false);
	await first.getByLabel('Timeline entries').getByText('Unseen reply', { exact: true }).waitFor({ timeout: 15000 });
	await first.reload();
	await first.getByLabel('Timeline entries').getByText('Unseen reply', { exact: true }).waitFor();
	assert.equal(await first.getByLabel('Timeline entries').getByText('Root one typed', { exact: true }).count(), 0);
	assert.equal(await first.getByLabel('Timeline entries').getByText('Root two edited offline', { exact: true }).count(), 0);

	await first.getByLabel('Capture a thought').fill('Cycle A');
	await first.getByRole('button', { name: 'Add entry' }).click();
	const cycleAUrl = first.url();
	const cycleAId = new URL(cycleAUrl).searchParams.get('entry');
	assert(cycleAId);
	await first.getByRole('button', { name: 'Capture' }).click();
	await first.getByLabel('Capture a thought').fill('Cycle B');
	await first.getByRole('button', { name: 'Add entry' }).click();
	const cycleBUrl = first.url();
	const cycleBId = new URL(cycleBUrl).searchParams.get('entry');
	assert(cycleBId);
	await second.getByRole('button', { name: 'Capture' }).click();
	await second.getByLabel('Timeline entries').getByText('Cycle B', { exact: true }).waitFor();
	await first.goto(cycleAUrl);
	await second.goto(cycleBUrl);
	await Promise.all([
		first.getByLabel('Entry text').waitFor(),
		second.getByLabel('Entry text').waitFor(),
	]);
	await Promise.all([firstContext.setOffline(true), secondContext.setOffline(true)]);
	await first.getByRole('button', { name: 'Move', exact: true }).click();
	await first.getByLabel('Move destination').selectOption(cycleBId);
	await first.getByRole('button', { name: 'Move entry' }).click();
	await second.getByRole('button', { name: 'Move', exact: true }).click();
	await second.getByLabel('Move destination').selectOption(cycleAId);
	await second.getByRole('button', { name: 'Move entry' }).click();
	await Promise.all([firstContext.setOffline(false), secondContext.setOffline(false)]);
	const visibleRootUrl = cycleAId < cycleBId ? cycleAUrl : cycleBUrl;
	const visibleChild = cycleAId < cycleBId ? 'Cycle B' : 'Cycle A';
	await first.goto(visibleRootUrl);
	await first.getByLabel('Replies').getByText(visibleChild, { exact: true }).waitFor({ timeout: 15000 });
	await second.goto(visibleRootUrl);
	await second.getByLabel('Replies').getByText(visibleChild, { exact: true }).waitFor({ timeout: 15000 });
	assert.deepEqual(errors, []);
	console.log(
		'Capture browser proof passed: typing, reload, nesting, move, confirmed deletion, unseen child survival, offline cycle, and two signed-in replicas.',
	);
} catch (cause) {
	console.error(cause);
	console.error(logs.slice(-35).join(''));
	throw cause;
} finally {
	await browser?.close();
	await proxy?.dispose();
	for (const child of children) {
		if (child.pid) {
			try {
				process.kill(-child.pid, 'SIGTERM');
			} catch (cause) {
				if (
					!(cause instanceof Error && 'code' in cause && cause.code === 'ESRCH')
				)
					console.error('Could not stop a disposable test process.', cause);
			}
		}
	}
	rmSync(temporary, { recursive: true, force: true });
}
