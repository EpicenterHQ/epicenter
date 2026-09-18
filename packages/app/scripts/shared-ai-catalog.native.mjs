/** macOS native acceptance. Run from the root with Bun; never uses a real profile. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	symlink,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { installApplication } from '../../../apps/epicenter/src/app-installation.ts';

assert.equal(
	process.platform,
	'darwin',
	'Requires macOS 14+, Xcode tools, and an unlocked keychain',
);
const root = resolve(import.meta.dir, '../../..');
const evidence = await realpath(
	await mkdtemp(join(tmpdir(), 'shared-ai-catalog-native-')),
);
console.log(`Native catalog evidence: ${evidence}`);
const desktop = join(evidence, 'desktop');
const native = join(desktop, 'src-tauri');
const profile = join(evidence, 'profile');
const identifier = `so.epicenter.catalog-acceptance.${randomUUID()}`;
const storeId = [...randomBytes(16)];
const fixtureKeys = [
	'catalog-fixture-initial',
	'catalog-fixture-rotated',
	'catalog-fixture-repaired',
];
const checks = [];
const verifyProduct = process.argv.includes('--whispering');
const productAudio = process.env.EPICENTER_NATIVE_AUDIO;
const productModel =
	'handy-computer/whisper-tiny-gguf@main/whisper-tiny-Q8_0.gguf';
const productRequests = [];
let nativeInference;
let nativeProcess;
let sequence = 0;
let fixtureHeld = false;
let fixtureAborts = 0;
const requests = [];
const fixture = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	idleTimeout: 0,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		if (path.startsWith('/product/v1/')) {
			assert(
				nativeInference,
				'Product acceptance requires the real inference fixture',
			);
			const observed = {
				path,
				authenticated:
					request.headers.get('authorization') ===
					'Bearer catalog-fixture-product',
			};
			productRequests.push(observed);
			if (!observed.authenticated) {
				observed.status = 401;
				return new Response(null, { status: 401 });
			}
			if (path.endsWith('/audio/transcriptions')) {
				const form = await request.clone().formData();
				const file = form.get('file');
				assert(file instanceof File);
				Object.assign(observed, {
					model: form.get('model'),
					byteLength: file.size,
					sha256: new Bun.CryptoHasher('sha256')
						.update(await file.arrayBuffer())
						.digest('hex'),
				});
			}
			const response = await nativeInference.transport.fetch(
				new Request(
					`${nativeInference.transport.baseURL}${path.slice('/product/v1'.length)}`,
					request,
				),
			);
			if (observed) {
				observed.status = response.status;
				const body = await response.clone().json();
				observed.transcript = body.text;
				if (!response.ok) observed.error = body;
			}
			return response;
		}
		requests.push({
			path: new URL(request.url).pathname,
			authorization: request.headers.get('authorization'),
			cookie: request.headers.get('cookie'),
		});
		if (fixtureHeld)
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('{"data":['));
						request.signal.addEventListener(
							'abort',
							() => {
								fixtureAborts++;
								controller.close();
							},
							{ once: true },
						);
					},
				}),
				{ headers: { 'content-type': 'application/json' } },
			);
		return Response.json({ data: [{ id: 'manual', object: 'model' }] });
	},
});
const endpoint = `${fixture.url.origin}/v1`;
const reserve = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	fetch: () => new Response(),
});
const port = reserve.port;
await reserve.stop(true);
const environment = {
	...process.env,
	CARGO_TARGET_DIR: join(root, 'apps/epicenter/src-tauri/target'),
	EPICENTER_DATA_DIR: profile,
	EPICENTER_FOLDER_DIR: join(evidence, 'checkout'),
	EPICENTER_DEV_PORT: String(port),
	EPICENTER_ACCEPTANCE_DIR: evidence,
};
async function run(command, options = {}) {
	const child = Bun.spawn(command, {
		cwd: root,
		env: environment,
		stdout: 'inherit',
		stderr: 'inherit',
		...options,
	});
	assert.equal(await child.exited, 0, command.join(' '));
}
async function until(label, predicate, timeout = 20_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await predicate();
		if (value) return value;
		await Bun.sleep(100);
	}
	throw new Error(`Timed out: ${label}`);
}
async function command(action, fields = {}) {
	const id = ++sequence;
	await writeFile(
		join(evidence, 'command.tmp'),
		JSON.stringify({ id, action, ...fields }),
	);
	await rename(join(evidence, 'command.tmp'), join(evidence, 'command.json'));
	const result = await until(`${action} ${id}`, async () => {
		try {
			return JSON.parse(
				await readFile(join(evidence, `result-${id}.json`), 'utf8'),
			);
		} catch (error) {
			if (error.code === 'ENOENT') return;
			throw error;
		}
	});
	assert.equal(result.error, undefined, JSON.stringify(result));
	return result.value;
}
async function evaluate(product, expression) {
	const id = sequence + 1;
	return command('eval', {
		product,
		script: `(async()=>{try{const value=await(async()=>{${expression}})(); await window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'catalog-acceptance',payload:{id:${id},value:value??null}});}catch(error){await window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'catalog-acceptance',payload:{id:${id},error:String(error),stack:error?.stack,causes:Array.from(error?.errors??[]).map(cause=>({name:cause?.name,message:String(cause),stack:cause?.stack}))}});}})()`,
	});
}
const a = 'so.epicenter.catalog-test-a';
const b = 'so.epicenter.catalog-test-b';
async function ready(product) {
	await until(`${product} document`, () =>
		evaluate(product, 'return Boolean(window.acceptance);'),
	);
	await evaluate(product, 'await acceptance.ready; return true;');
}
async function records(product) {
	return evaluate(product, 'return acceptance.records();');
}
async function observe(product, id, predicate = () => true) {
	return until('committed snapshot', async () => {
		const record = (await records(product)).find((record) => record.id === id);
		return record && predicate(record) ? record : undefined;
	});
}
async function update(id, patch) {
	await evaluate(
		b,
		`await acceptance.update(${JSON.stringify(id)},${JSON.stringify(patch)});`,
	);
}
async function start() {
	await unlink(join(evidence, 'bun-exit.json')).catch((error) => {
		if (error.code !== 'ENOENT') throw error;
	});
	nativeProcess = Bun.spawn(
		[join(environment.CARGO_TARGET_DIR, 'debug/examples/catalog_acceptance')],
		{
			env: environment,
			stdout: Bun.file(join(evidence, `native-${sequence}.log`)),
			stderr: 'inherit',
		},
	);
	await until(
		'host HTTP listener',
		async () => {
			if (nativeProcess.exitCode !== null)
				throw new Error(`Native process exited: ${nativeProcess.exitCode}`);
			try {
				return (
					(
						await fetch(
							`http://127.0.0.1:${port}/_epicenter/ai/no-account/connections`,
						)
					).status === 401
				);
			} catch {
				return false;
			}
		},
		30_000,
	);
	const pids = await command('launch', { product: a });
	// Native startup prewarms Whispering. Close that unrelated product window so
	// this run's SSE counts address just the two declared acceptance apps.
	await command('destroy', { product: 'whispering' });
	await command('launch', { product: b });
	await ready(a);
	await ready(b);
	return pids;
}
async function stop() {
	await command('quit');
	assert.equal(
		await Promise.race([
			nativeProcess.exited,
			Bun.sleep(10_000).then(() => 'timeout'),
		]),
		0,
		'Native host shuts down',
	);
	assert.equal(
		await Bun.file(join(evidence, 'bun-exit.json')).json(),
		0,
		'Bun sidecar exits cleanly',
	);
	await until('host port released', async () => {
		try {
			await fetch(`http://127.0.0.1:${port}/`);
			return false;
		} catch {
			return true;
		}
	});
}

try {
	if (verifyProduct) {
		assert(
			productAudio,
			'--whispering requires EPICENTER_NATIVE_AUDIO pointing to an existing speech WAV',
		);
		const { createNativeAiFixture } = await import('./native-ai-fixture.ts');
		nativeInference = await createNativeAiFixture({
			audioPath: productAudio,
			timeoutMs: 600_000,
		});
	}
	await mkdir(desktop, { recursive: true });
	await run([
		'rsync',
		'-a',
		'--exclude=target',
		'--exclude=binaries',
		'--exclude=transcribe-libs',
		`${root}/apps/epicenter/src-tauri/`,
		`${native}/`,
	]);
	await run(['rsync', '-a', `${root}/apps/epicenter/src/`, `${desktop}/src/`]);
	await symlink(
		join(root, 'apps/epicenter/node_modules'),
		join(desktop, 'node_modules'),
	);
	await symlink(join(root, 'apps/epicenter/dist'), join(desktop, 'dist'));
	const config = await Bun.file(join(native, 'tauri.conf.json')).json();
	config.identifier = identifier;
	config.productName = 'Catalog acceptance';
	config.build = { frontendDist: 'frontend-placeholder' };
	config.bundle = { active: false, icon: ['icons/icon.png'] };
	config.app.security.capabilities = [
		'trusted-app-windows-development',
		'home-launch-application-development',
		...(verifyProduct
			? [
					'trusted-whispering-native-development',
					'trusted-whispering-overlay-development',
				]
			: []),
		'catalog-acceptance',
	];
	await Bun.write(join(native, 'tauri.conf.json'), JSON.stringify(config));
	await Bun.write(
		join(native, 'capabilities/catalog-acceptance.json'),
		JSON.stringify({
			identifier: 'catalog-acceptance',
			local: false,
			windows: [
				'app-so_epicenter_catalog-test-*',
				...(verifyProduct ? ['whispering'] : []),
			],
			remote: { urls: [`http://127.0.0.1:${port}`] },
			permissions: ['core:event:allow-emit'],
		}),
	);
	let rust = await Bun.file(join(native, 'src/lib.rs')).text();
	assert(rust.includes('specta_builder.mount_events(app);'));
	rust = rust.replace(
		'specta_builder.mount_events(app);',
		'specta_builder.mount_events(app);\n            start_catalog_acceptance(app.handle());',
	);
	rust = rust.replaceAll(
		'.initialization_script(initialization_script)',
		`.data_store_identifier([${storeId}]).initialization_script(initialization_script)`,
	);
	assert(rust.includes('let _ = process.child.wait();'));
	rust = rust.replace(
		'let _ = process.child.wait();',
		`let status = process.child.wait().unwrap();\n    fs::write(std::path::Path::new(&std::env::var("EPICENTER_ACCEPTANCE_DIR").unwrap()).join("bun-exit.json"), serde_json::to_string(&status.code()).unwrap()).unwrap();`,
	);
	rust += await Bun.file(
		join(import.meta.dir, 'shared-ai-catalog-native/driver.rs'),
	).text();
	await Bun.write(join(native, 'src/lib.rs'), rust);
	const overlayPath = join(native, 'src/overlay.rs');
	const overlay = await Bun.file(overlayPath).text();
	assert(overlay.includes('.initialization_script(initialization_script)'));
	await Bun.write(
		overlayPath,
		overlay.replace(
			'.initialization_script(initialization_script)',
			`.data_store_identifier([${storeId}]).initialization_script(initialization_script)`,
		),
	);
	// Cut only the SSE response at the network boundary in the disposable host.
	// The real route, subscription cleanup, and EventSource reconnect stay intact.
	let main = await Bun.file(join(desktop, 'src/main.ts')).text();
	assert(main.includes('fetch: app.fetch,'));
	main = main.replace(
		'fetch: app.fetch,',
		`fetch: async (request, server) => {
 const response = await app.fetch(request, server);
 if (!new URL(request.url).pathname.endsWith('/_epicenter/ai/no-account/events') || !response.body) return response;
 const reader = response.body.getReader();
 let done = false;
 const activePath = ${JSON.stringify(join(evidence, 'events.json'))};
 const cutPath = ${JSON.stringify(join(evidence, 'cut-events'))};
 const stats = globalThis.__catalogEvidence ??= {opened:0,active:0,closed:0};
 const save = () => { const fs = require('node:fs'); fs.writeFileSync(activePath+'.tmp', JSON.stringify(stats)); fs.renameSync(activePath+'.tmp',activePath); };
 stats.opened++; stats.active++; save();
 let timer;
 const finish = async () => { if(done)return; done=true; clearInterval(timer); stats.active--;stats.closed++;save(); await reader.cancel(); };
 const body = new ReadableStream({
  start(controller) { timer=setInterval(async()=>{ if(require('node:fs').existsSync(cutPath)){ await finish();try{controller.close();}catch{} } },100); },
  async pull(controller) { try { const next=await reader.read(); if(done)return; if(next.done){await finish();controller.close();}else controller.enqueue(next.value); }catch(error){await finish();controller.error(error);} },
  cancel: finish,
 });
 request.signal.addEventListener('abort',()=>{void finish();},{once:true});
 return new Response(body,{status:response.status,headers:response.headers});
},`,
	);
	await Bun.write(join(desktop, 'src/main.ts'), main);
	for (const product of [a, b]) {
		const source = join(evidence, product);
		await mkdir(source);
		await writeFile(
			join(source, 'index.html'),
			`<html><head><title>${product}: native catalog test app</title></head><body><script type="module" src="${join(import.meta.dir, 'shared-ai-catalog-native/page.ts')}"></script></body></html>`,
		);
		await build({
			configFile: false,
			root: source,
			base: `/apps/${product}/`,
			resolve: { conditions: ['epicenter-host', 'browser'] },
			worker: { format: 'es' },
			build: { target: 'esnext', outDir: 'dist', minify: false },
		});
		await writeFile(
			join(source, 'dist/manifest.json'),
			JSON.stringify({
				id: product,
				title: `${product} (acceptance only)`,
				version: '1',
			}),
		);
		await installApplication({
			releaseRoot: join(source, 'dist'),
			dataRoot: profile,
		});
	}
	await mkdir(join(native, 'examples'), { recursive: true });
	await writeFile(
		join(native, 'examples/catalog_acceptance.rs'),
		'fn main() { epicenter_lib::run(); }',
	);
	await run([
		'cargo',
		'build',
		'--manifest-path',
		join(native, 'Cargo.toml'),
		'--example',
		'catalog_acceptance',
	]);
	const first = await start();
	assert.deepEqual(await records(a), []);
	assert.deepEqual(await records(b), []);
	const legacy = await evaluate(
		a,
		`return localStorage.getItem('${a}.app-ai-connections');`,
	);
	assert.equal(JSON.parse(legacy).connections[0].id, 'native-legacy');
	assert.equal(await evaluate(a, 'return acceptance.selected();'), null);
	assert.equal(await evaluate(b, 'return acceptance.selected();'), null);
	const id = await evaluate(
		a,
		`return acceptance.add(${JSON.stringify({ name: 'Fixture', baseUrl: endpoint, apiKey: fixtureKeys[0], models: ['manual'] })});`,
	);
	const original = await observe(b, id);
	assert.equal(original.hasApiKey, true);
	assert.equal('apiKey' in original, false);
	await evaluate(
		a,
		`acceptance.select(${JSON.stringify(id)}); acceptance.retain(${JSON.stringify(id)});`,
	);
	const removable = await evaluate(
		b,
		`return acceptance.add(${JSON.stringify({ name: 'Second fixture', baseUrl: endpoint, models: ['manual'] })});`,
	);
	await evaluate(b, `acceptance.select(${JSON.stringify(removable)});`);
	await evaluate(b, `return acceptance.run(${JSON.stringify(id)});`);
	assert.equal(requests.at(-1).authorization, `Bearer ${fixtureKeys[0]}`);
	assert.equal(requests.at(-1).cookie, null);
	checks.push(
		'built installed test apps use the default desktop binding and real Rust keychain',
	);
	await update(id, { name: 'Renamed' });
	await observe(a, id, (record) => record.name === 'Renamed');
	assert.equal(await evaluate(a, 'return acceptance.retained();'), 'sent');
	await update(id, { apiKey: fixtureKeys[1] });
	await observe(
		a,
		id,
		(record) => record.accessVersion !== original.accessVersion,
	);
	assert.equal(await evaluate(a, 'return acceptance.retained();'), 'rejected');
	await evaluate(a, `return acceptance.run(${JSON.stringify(id)});`);
	assert.equal(requests.at(-1).authorization, `Bearer ${fixtureKeys[1]}`);
	const beforeSameKey = (await records(b)).find((record) => record.id === id);
	await evaluate(a, `acceptance.retain(${JSON.stringify(id)});`);
	await update(id, { apiKey: fixtureKeys[1] });
	await observe(
		a,
		id,
		(record) => record.accessVersion !== beforeSameKey.accessVersion,
	);
	assert.equal(await evaluate(a, 'return acceptance.retained();'), 'rejected');
	const beforeStaleRequest = requests.length;
	assert.equal(
		await evaluate(
			a,
			`return (await fetch('/_epicenter/ai/no-account/inference/${id}/${original.accessVersion}/models')).status;`,
		),
		400,
	);
	assert.equal(requests.length, beforeStaleRequest);
	await update(id, { apiKey: '' });
	await observe(a, id, (record) => !record.hasApiKey);
	await evaluate(a, `return acceptance.run(${JSON.stringify(id)});`);
	assert.equal(requests.at(-1).authorization, null);
	await update(id, { apiKey: fixtureKeys[1] });
	const metadataPath = join(profile, 'ai/no-account/connections.json');
	const saved = (await Bun.file(metadataPath).json()).connections.find(
		(record) => record.id === id,
	);
	await observe(
		a,
		id,
		(record) => record.accessVersion === saved.accessVersion,
	);
	await command('delete-key', { label: `ai.${id}.${saved.secretVersion}` });
	const countBeforeMissing = requests.length;
	assert.equal(
		await evaluate(
			a,
			`try{await acceptance.run(${JSON.stringify(id)});return 'sent';}catch{return 'failed';}`,
		),
		'failed',
	);
	assert.equal(requests.length, countBeforeMissing);
	await update(id, { name: 'Missing key can be renamed' });
	await update(id, { apiKey: fixtureKeys[2] });
	const repaired = (await records(b)).find((record) => record.id === id);
	await observe(
		a,
		id,
		(record) => record.accessVersion === repaired.accessVersion,
	);
	await evaluate(a, `return acceptance.run(${JSON.stringify(id)});`);
	assert.equal(requests.at(-1).authorization, `Bearer ${fixtureKeys[2]}`);
	await evaluate(a, `acceptance.retain(${JSON.stringify(id)});`);
	await update(id, { baseUrl: `${fixture.url.origin}/changed/v1` });
	await observe(a, id, (record) => record.baseUrl.endsWith('/changed/v1'));
	assert.equal(await evaluate(a, 'return acceptance.retained();'), 'rejected');
	await evaluate(a, `return acceptance.run(${JSON.stringify(id)});`);
	assert.equal(requests.at(-1).path, '/changed/v1/models');
	assert.equal(requests.at(-1).authorization, `Bearer ${fixtureKeys[2]}`);
	checks.push(
		'hidden key retention, rotation, removal, missing-key refusal and repair, stale-client retirement',
	);
	await evaluate(b, `await acceptance.remove(${JSON.stringify(removable)});`);
	const selectedA = await evaluate(a, 'return acceptance.selected();');
	const selectedB = await evaluate(b, 'return acceptance.selected();');
	assert.notDeepEqual(selectedA, selectedB);
	for (const key of fixtureKeys)
		assert.equal((await readFile(metadataPath, 'utf8')).includes(key), false);
	for (const product of [a, b]) {
		const snapshot = await records(product);
		assert(snapshot.every((record) => !('apiKey' in record)));
		for (const key of fixtureKeys)
			assert(!JSON.stringify(snapshot).includes(key));
	}
	const events = () => Bun.file(join(evidence, 'events.json')).json();
	await until('two subscriptions', async () => (await events()).active === 2);
	const beforeCut = await events();
	const documentId = await evaluate(a, 'return acceptance.documentId;');
	await writeFile(join(evidence, 'cut-events'), 'cut');
	await until('SSE interruption', async () => (await events()).active === 0);
	await update(id, { name: 'Changed while disconnected' });
	await import('node:fs/promises').then(({ unlink }) =>
		unlink(join(evidence, 'cut-events')),
	);
	await until(
		'SSE reconnect',
		async () =>
			(await events()).active === 2 &&
			(await events()).opened >= beforeCut.opened + 2,
	);
	await observe(
		a,
		id,
		(record) => record.name === 'Changed while disconnected',
	);
	assert.equal(await evaluate(a, 'return acceptance.documentId;'), documentId);
	checks.push(
		'real WebKit EventSource reconnect receives subsequent catalog updates',
	);
	await stop();
	assert.equal((await events()).active, 0);
	const second = await start();
	assert.notEqual(first.nativePid, second.nativePid);
	assert.notEqual(first.bunPid, second.bunPid);
	assert.equal(
		(await records(a)).some((record) => record.id === 'native-legacy'),
		false,
	);
	assert.equal(
		(await records(a)).some((record) => record.id === removable),
		false,
	);
	assert.equal(
		await evaluate(
			a,
			`return localStorage.getItem('${a}.app-ai-connections');`,
		),
		legacy,
	);
	assert.deepEqual(
		await evaluate(a, 'return acceptance.selected();'),
		selectedA,
	);
	assert.deepEqual(
		await evaluate(b, 'return acceptance.selected();'),
		selectedB,
	);
	await evaluate(a, `return acceptance.run(${JSON.stringify(id)});`);
	assert.equal(requests.at(-1).authorization, `Bearer ${fixtureKeys[2]}`);
	checks.push(
		'native and Bun process restart preserves ID, keychain credential, independent selections and legacy bytes without adoption or deleted connection resurrection',
	);
	fixtureHeld = true;
	const beforeClose = requests.length;
	await evaluate(a, `acceptance.start(${JSON.stringify(id)});`);
	await until('held inference', () => requests.length > beforeClose);
	assert.equal(await evaluate(a, 'return acceptance.close();'), 'rejected');
	await until(
		'App close releases SSE',
		async () => (await events()).active === 1,
	);
	await until('App close aborts upstream body', () => fixtureAborts >= 1);
	await command('destroy', { product: a });
	await evaluate(b, `acceptance.start(${JSON.stringify(id)});`);
	await until('second held inference', () => requests.length > beforeClose + 1);
	await command('destroy', { product: b });
	await until(
		'window destruction releases SSE',
		async () => (await events()).active === 0,
	);
	await until('window destruction aborts upstream', () => fixtureAborts >= 2);
	await command('launch', { product: b });
	await ready(b);
	await evaluate(b, `acceptance.start(${JSON.stringify(id)});`);
	await until(
		'shutdown held inference',
		() => requests.length > beforeClose + 2,
	);
	await stop();
	await until('host shutdown aborts upstream', () => fixtureAborts >= 3);
	assert.equal((await events()).active, 0);
	checks.push(
		'App close, window destruction and native shutdown release SSE and admitted inference bodies',
	);
	fixtureHeld = false;
	await start();
	let productAcceptance;
	if (verifyProduct) {
		const { verifyWhispering } = await import(
			'./shared-ai-catalog-native/whispering.mjs'
		);
		productAcceptance = await verifyWhispering({
			command,
			evaluate,
			until,
			records,
			endpoint: `${fixture.url.origin}/product/v1`,
			apiKey: 'catalog-fixture-product',
			audioPath: productAudio,
			model: productModel,
			requests: productRequests,
			evidence,
		});
		checks.push(
			'actual Whispering desktop picker, imported audio, real transcription and persisted result after reload',
		);
	}
	const cspObservations = [
		await evaluate(a, 'return acceptance.violations();'),
		await evaluate(b, 'return acceptance.violations();'),
	];
	await evaluate(b, `await acceptance.remove(${JSON.stringify(id)});`);
	await evaluate(a, 'await acceptance.close();');
	await evaluate(b, 'await acceptance.close();');
	await stop();
	await writeFile(
		join(evidence, 'result.json'),
		JSON.stringify(
			{
				passed: true,
				identifier,
				checks,
				first,
				second,
				cspObservations,
				...(productAcceptance ? { productAcceptance } : {}),
				requests: requests.map(({ authorization, ...request }) => ({
					...request,
					authenticated: Boolean(authorization),
				})),
				fixtureAborts,
				webviewStoreId: storeId,
			},
			null,
			2,
		),
	);
	console.log(`Native catalog acceptance passed: ${evidence}/result.json`);
} catch (error) {
	if (verifyProduct && nativeProcess?.exitCode === null) {
		await evaluate(
			'whispering',
			'document.querySelector("a[href$=\\"/recordings\\"]")?.click();return true;',
		).catch(() => {});
		await Bun.sleep(500);
		const document = await evaluate(
			'whispering',
			'return {text:document.body.innerText,errors:window.acceptanceErrors,fields:Array.from(document.querySelectorAll("textarea")).map(element=>({label:element.getAttribute("aria-label"),value:element.value}))};',
		).catch(String);
		await Bun.write(
			join(evidence, 'whispering-failure.json'),
			JSON.stringify({ document, requests: productRequests }, null, 2),
		);
	}
	await writeFile(
		join(evidence, 'result.json'),
		JSON.stringify(
			{ passed: false, checks, error: String(error), stack: error.stack },
			null,
			2,
		),
	);
	throw error;
} finally {
	if (nativeProcess?.exitCode === null) {
		try {
			await stop();
		} catch {
			nativeProcess.kill();
			await nativeProcess.exited;
		}
	}
	await fixture.stop(true);
	// Every credential in this fresh service belongs to this run, including a
	// key left by a failed assertion. Never inspect or delete another service.
	let deleted = 0;
	for (;;) {
		const cleanup = Bun.spawn(
			['security', 'delete-generic-password', '-s', identifier],
			{ stdout: 'ignore', stderr: 'ignore' },
		);
		const code = await cleanup.exited;
		if (code === 44) break;
		assert.equal(code, 0, 'Delete fixture-only keychain entries');
		deleted++;
	}
	const reportPath = join(evidence, 'result.json');
	const inferenceCleanup = await nativeInference?.close();
	const report = await Bun.file(reportPath).json();
	await Bun.write(
		reportPath,
		JSON.stringify(
			{
				...report,
				fixtureCredentialsRemoved: deleted,
				fixtureKeychainEmpty: true,
				...(inferenceCleanup ? { inferenceCleanup } : {}),
			},
			null,
			2,
		),
	);
}
