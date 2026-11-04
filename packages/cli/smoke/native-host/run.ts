/**
 * End to end: Playwright's Chromium loads a minimal MV3 extension that saves
 * tabs through `so.epicenter.engine`, with a throwaway HOME and user data
 * directory, so the real browser profile and ~/Epicenter are untouched.
 * The engine is compiled as the app compiles it, and linked as the app
 * links it. `HEADED=1` shows the window.
 *
 * ```sh
 * bun packages/cli/smoke/native-host/run.ts
 * ```
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { chromium } from 'playwright';
import { installNativeHost } from '../../src/native-host-manifest.ts';

const box = realpathSync(mkdtempSync(join(tmpdir(), 'epicenter-nm-')));
console.log('scratch', box);
const engineBinary = join(box, 'epicenter-cli');
await $`bun build --compile --minify --bytecode --define ${'__EPICENTER_BUILD_ENVIRONMENT__="production"'} --outfile ${engineBinary} ${join(import.meta.dir, '../../src/bin.ts')}`.quiet();
const HOME = join(box, 'home');
const userData = join(box, 'user-data');
const ext = join(box, 'ext');
mkdirSync(join(HOME, '.epicenter', 'bin'), { recursive: true });
mkdirSync(ext, { recursive: true });
const engine = join(HOME, '.epicenter', 'bin', 'epicenter');
symlinkSync(engineBinary, engine); // as link_engine does

// Pin the extension id with a manifest key: id = sha256(SPKI DER)[0..16] in a-p.
const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = publicKey.export({ type: 'spki', format: 'der' });
const id = [...createHash('sha256').update(der).digest('hex').slice(0, 32)]
	.map((c) => String.fromCharCode(97 + Number.parseInt(c, 16)))
	.join('');
writeFileSync(
	join(ext, 'manifest.json'),
	JSON.stringify({
		manifest_version: 3,
		name: 'Tabs native messaging spike',
		version: '0.0.1',
		key: der.toString('base64'),
		permissions: ['nativeMessaging', 'storage'],
		background: { service_worker: 'background.js' },
	}),
);
cpSync(join(import.meta.dir, 'background.js'), join(ext, 'background.js'));

const headless = process.env.HEADED !== '1';
const context = await chromium.launchPersistentContext(userData, {
	channel: 'chromium',
	headless,
	args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
	env: { ...process.env, HOME },
});
const worker =
	context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
const loadedId = new URL(worker.url()).host;
console.log('headless', headless, 'pinned id', id, 'loaded id', loadedId);
const call = (fn: string, ...args: unknown[]) =>
	worker.evaluate(
		([fn, args]: [string, unknown[]]) =>
			(
				(
					self as unknown as {
						tabs: Record<string, (...a: unknown[]) => unknown>;
					}
				).tabs[fn] as (...a: unknown[]) => unknown
			)(...args),
		[fn, args],
	);
const show = (label: string, value: unknown) =>
	console.log(label, JSON.stringify(value));

// 1. No host installed: the save stays in chrome.storage.local.
show(
	'1 save, no host:',
	await call('saveTab', { url: 'https://offline.example/', title: 'Kept' }),
);
show('  pending:', await call('pending'));

// 2. Install the wrapper and manifest where this browser looks.
const hosts = join(userData, 'NativeMessagingHosts');
const installed = await installNativeHost({
	engine,
	environment: 'production',
	extensionIds: [id],
	manifestDirectories: [hosts],
});
show('2 installed', installed);
console.log(`  wrapper:\n${readFileSync(installed.wrapper, 'utf8')}`);

// 3. A manifest whose path carries an argument, and the bare engine.
const extra = (name: string, path: string) =>
	writeFileSync(
		join(hosts, `${name}.json`),
		JSON.stringify({
			name,
			description: 'x',
			path,
			type: 'stdio',
			allowed_origins: [`chrome-extension://${id}/`],
		}),
	);
extra('so.epicenter.argtest', `${engine} native-host`);
show(
	'3 path with an argument:',
	await call('native', { op: 'list' }, 'so.epicenter.argtest'),
);
extra('so.epicenter.bare', engine);
show(
	'3b bare engine as path:',
	await call('native', { op: 'list' }, 'so.epicenter.bare'),
);

// 4. Hand over what was kept, then save and list through the engine.
show('4 hand over:', await call('handOver'));
show(
	'  save:',
	await call('saveTab', { url: 'https://example.com/', title: 'Example' }),
);
show('  list:', await call('native', { op: 'list' }));
show('  sync:', await call('native', { op: 'sync' }));
const folder = join(HOME, 'Epicenter', 'tabs', 'tabs');
for (const f of readdirSync(folder))
	console.log(`  ${folder}/${f}:\n${readFileSync(join(folder, f), 'utf8')}`);

// 5. Latency: sendNativeMessage spawns a host per message; a port keeps one.
const times: number[] = [];
for (let i = 0; i < 10; i++) {
	const t = performance.now();
	await call('native', { op: 'list' });
	times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
console.log(
	'5 sendNativeMessage list x10 ms: median',
	times[5]?.toFixed(0),
	'min',
	times[0]?.toFixed(0),
	'max',
	times[9]?.toFixed(0),
);
const viaPort = (await call(
	'port',
	Array.from({ length: 10 }, () => ({ op: 'list' })),
)) as { ms?: number; answers: unknown[]; error?: string };
console.log(
	'  connectNative 10 lists on one port ms:',
	viaPort.ms?.toFixed(0),
	'answers',
	viaPort.answers.length,
	viaPort.error ?? '',
);

// 6. Another extension's origin is refused.
const manifestPath = join(hosts, 'so.epicenter.engine.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
writeFileSync(
	manifestPath,
	JSON.stringify({
		...manifest,
		allowed_origins: ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'],
	}),
);
show('6 another extension id:', await call('native', { op: 'list' }));

await context.close();
