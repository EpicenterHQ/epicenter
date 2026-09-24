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

	await first
		.getByLabel('Add a capture')
		.fill('Dinner with Sebastian\nFriday at seven\nBring the invitation.');
	await first.getByRole('button', { name: 'Add a capture' }).click();
	const dinnerUrl = first.url();
	const dinnerId = new URL(dinnerUrl).searchParams.get('capture');
	assert(dinnerId);
	await first
		.getByLabel('Capture text')
		.fill(
			'Dinner with Sebastian\nFriday at seven\nBring the invitation.\nFull pasted details.',
		);
	await first.getByRole('status').getByText('Saved on this device').waitFor();
	await second
		.getByLabel('Timeline captures')
		.getByText('Dinner with Sebastian', { exact: true })
		.waitFor();
	await second.goto(dinnerUrl);
	await second.getByLabel('Capture text').waitFor();
	assert.equal(
		await second.getByLabel('Capture text').inputValue(),
		'Dinner with Sebastian\nFriday at seven\nBring the invitation.\nFull pasted details.',
	);

	for (const thought of [
		'Owning the outcome',
		'Moving to Singapore\nA longer thought',
		'A question for next time',
	]) {
		await first.getByLabel('Add a thought').fill(thought);
		await first.getByRole('button', { name: 'Add thought' }).click();
	}
	await second.getByLabel('Thoughts').locator('article').nth(2).waitFor();
	await first
		.getByLabel('Thoughts')
		.locator('article')
		.nth(2)
		.getByRole('button', { name: 'Move up' })
		.click();
	await first.getByRole('status').getByText('Saved on this device').waitFor();
	await second.waitForFunction(
		() =>
			(
				document.querySelector(
					'[aria-label="Thoughts"] article:nth-child(2) textarea',
				) as HTMLTextAreaElement
			)?.value === 'A question for next time',
	);
	await second.reload();
	await second.getByLabel('Thoughts').locator('article').nth(2).waitFor();
	assert.equal(
		await second
			.getByLabel('Thoughts')
			.locator('article')
			.nth(1)
			.getByLabel('Thought text')
			.inputValue(),
		'A question for next time',
	);
	await second
		.getByLabel('Thoughts')
		.locator('article')
		.nth(0)
		.getByLabel('Thought text')
		.fill('Owning the outcome, edited independently');
	await first.waitForFunction(
		() =>
			(
				document.querySelector(
					'[aria-label="Thoughts"] article:first-child textarea',
				) as HTMLTextAreaElement
			)?.value === 'Owning the outcome, edited independently',
	);

	await second.getByRole('button', { name: 'Capture', exact: true }).click();
	await second.getByLabel('Add a capture').fill('Second capture');
	await second.getByRole('button', { name: 'Add a capture' }).click();
	const secondUrl = second.url();
	const secondId = new URL(secondUrl).searchParams.get('capture');
	assert(secondId);
	await first.getByRole('button', { name: 'Capture', exact: true }).click();
	await first
		.getByLabel('Timeline captures')
		.getByRole('button')
		.first()
		.getByText('Second capture')
		.waitFor();
	await first
		.getByLabel('Timeline captures')
		.getByRole('button')
		.nth(1)
		.getByText('Dinner with Sebastian')
		.waitFor();
	await first.goto(dinnerUrl);
	await first
		.getByLabel('Thoughts')
		.locator('article')
		.nth(1)
		.getByLabel('Move thought to capture')
		.selectOption(secondId);
	await first
		.getByLabel('Thoughts')
		.locator('article')
		.nth(1)
		.getByRole('button', { name: 'Move', exact: true })
		.click();
	await second.goto(secondUrl);
	await second.getByLabel('Thoughts').getByLabel('Thought text').waitFor();
	assert.equal(
		await second.getByLabel('Thoughts').getByLabel('Thought text').inputValue(),
		'A question for next time',
	);

	await second.goto(dinnerUrl);
	await first.getByRole('button', { name: 'Delete capture…' }).click();
	await first
		.getByRole('region', { name: 'Delete preview' })
		.getByText('Permanently delete this capture and 2 thoughts?')
		.waitFor();
	await second
		.getByLabel('Thoughts')
		.locator('article')
		.first()
		.getByLabel('Thought text')
		.fill('Changed during review');
	await first
		.getByText('This capture changed. Review the updated list before deleting.')
		.waitFor();
	await first.getByRole('button', { name: 'I reviewed the changes' }).click();
	await first.getByRole('button', { name: 'Cancel' }).click();

	// An offline replica adds a thought after the deleting replica's preview.
	await secondContext.setOffline(true);
	await second.getByLabel('Add a thought').fill('Unseen offline thought');
	await second.getByRole('button', { name: 'Add thought' }).click();
	await first.getByRole('button', { name: 'Delete capture…' }).click();
	await first
		.getByRole('button', { name: 'Permanently delete', exact: true })
		.click();
	await first.getByRole('heading', { name: 'Timeline' }).waitFor();
	await secondContext.setOffline(false);
	await first
		.getByRole('region', { name: 'Thought recovery' })
		.getByLabel('Thought text')
		.waitFor({ timeout: 15000 });
	assert.equal(
		await first
			.getByRole('region', { name: 'Thought recovery' })
			.getByLabel('Thought text')
			.inputValue(),
		'Unseen offline thought',
	);
	await first.reload();
	await first
		.getByRole('region', { name: 'Thought recovery' })
		.getByLabel('Thought text')
		.waitFor();
	await first
		.getByRole('region', { name: 'Thought recovery' })
		.getByLabel('Move thought to capture')
		.selectOption(secondId);
	await first
		.getByRole('region', { name: 'Thought recovery' })
		.getByRole('button', { name: 'Move', exact: true })
		.click();
	await first.getByRole('status').getByText('Saved on this device').waitFor();
	await first.goto(secondUrl);
	await first.getByRole('heading', { name: 'Capture' }).waitFor();
	await first
		.getByLabel('Thoughts')
		.getByLabel('Thought text')
		.nth(1)
		.waitFor();
	await first.getByLabel('Add a thought').fill('Third ordered thought');
	await first.getByRole('button', { name: 'Add thought' }).click();
	await first.getByRole('status').getByText('Saved on this device').waitFor();
	await second.goto(secondUrl);
	await second
		.getByLabel('Thoughts')
		.getByLabel('Thought text')
		.nth(2)
		.waitFor();
	await Promise.all([
		firstContext.setOffline(true),
		secondContext.setOffline(true),
	]);
	await first
		.getByLabel('Thoughts')
		.locator('article')
		.nth(2)
		.getByRole('button', { name: 'Move up' })
		.click();
	await second
		.getByLabel('Thoughts')
		.locator('article')
		.nth(0)
		.getByRole('button', { name: 'Move down' })
		.click();
	await Promise.all([
		firstContext.setOffline(false),
		secondContext.setOffline(false),
	]);
	await first.getByRole('status').getByText('Saved on this device').waitFor();
	await second.getByRole('status').getByText('Saved on this device').waitFor();
	await first.reload();
	await second.reload();
	await first
		.getByLabel('Thoughts')
		.getByLabel('Thought text')
		.nth(2)
		.waitFor();
	await second
		.getByLabel('Thoughts')
		.getByLabel('Thought text')
		.nth(2)
		.waitFor();
	const firstOrder = await first
		.getByLabel('Thoughts')
		.getByLabel('Thought text')
		.evaluateAll((items) =>
			items.map((item) => (item as HTMLTextAreaElement).value),
		);
	await second.waitForFunction((expected) => {
		const actual = [
			...document.querySelectorAll('[aria-label="Thoughts"] textarea'),
		].map((item) => (item as HTMLTextAreaElement).value);
		return JSON.stringify(actual) === JSON.stringify(expected);
	}, firstOrder);
	assert.equal(new Set(firstOrder).size, 3);
	assert.deepEqual(errors, []);
	console.log(
		'Capture browser proof passed: multiline text, two replicas, ordering and concurrent reorder, independent edits, moves, refreshed deletion, offline survival, and recovery.',
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
