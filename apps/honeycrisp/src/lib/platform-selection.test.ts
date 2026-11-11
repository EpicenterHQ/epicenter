/**
 * Honeycrisp platform resolution tests.
 *
 * Vite must select the host auth and instance leaves for the Epicenter host
 * and the browser leaves for the web and standalone desktop builds. The host
 * leaves must still construct the desktop broker implementations. Every new
 * platform seam needs both leaves. This probes module resolution, not the
 * contents of a finished asset bundle.
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));
const imports = (
	(await Bun.file(join(appRoot, 'package.json')).json()) as {
		imports: Record<string, Record<string, string>>;
	}
).imports;

const resolvePlatform = `
import { createServer } from 'vite';
import { resolve } from 'node:path';

const server = await createServer({
	root: process.cwd(),
	logLevel: 'silent',
	server: { middlewareMode: true },
	optimizeDeps: { noDiscovery: true },
});
try {
	const importer = resolve('src/routes/components/Sidebar.svelte');
	const auth = await server.pluginContainer.resolveId('#platform/auth', importer);
	const instance = await server.pluginContainer.resolveId('#platform/instance', importer);
	console.log(JSON.stringify({ auth: auth?.id, instance: instance?.id }));
} finally {
	await server.close();
}
`;

async function resolvedLeaves(host: boolean) {
	const child = Bun.spawn([process.execPath, '-e', resolvePlatform], {
		cwd: appRoot,
		env: { ...process.env, EPICENTER_HOST: host ? '1' : '0' },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(stderr);
	return JSON.parse(stdout.trim()) as { auth: string; instance: string };
}

test('every declared platform seam has host and default leaves', () => {
	for (const [specifier, conditions] of Object.entries(imports)) {
		expect(conditions['epicenter-host'], specifier).toEqual(expect.any(String));
		expect(conditions.default, specifier).toEqual(expect.any(String));
	}
});

test('Vite resolves host and browser leaves by the host setting', async () => {
	const [host, browser] = await Promise.all([
		resolvedLeaves(true),
		resolvedLeaves(false),
	]);
	expect(host).toEqual({
		auth: join(appRoot, 'src/lib/platform/auth.epicenter-host.ts'),
		instance: join(appRoot, 'src/lib/platform/instance.epicenter-host.ts'),
	});
	expect(browser).toEqual({
		auth: join(appRoot, 'src/lib/platform/auth.browser.ts'),
		instance: join(appRoot, 'src/lib/instance.ts'),
	});
});

test('host leaves construct desktop broker auth and instance settings', async () => {
	const auth = imports['#platform/auth']?.['epicenter-host'];
	const instance = imports['#platform/instance']?.['epicenter-host'];
	if (!auth || !instance) throw new Error('Honeycrisp host leaves are missing');
	expect(await Bun.file(join(appRoot, auth)).text()).toMatch(
		/export const auth\s*=\s*createDesktopBrokerAuth\s*\(/,
	);
	expect(await Bun.file(join(appRoot, instance)).text()).toMatch(
		/export const instanceSetting\s*=\s*createDesktopInstanceSetting\s*\(/,
	);
});
