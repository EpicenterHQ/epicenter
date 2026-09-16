/** Actual built Whispering in an isolated native host. Run on macOS from the repo root. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	symlink,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

assert.equal(
	process.platform,
	'darwin',
	'Requires macOS and physical microphone access',
);
const root = resolve(import.meta.dir, '../../..');
const gitHead = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
	cwd: root,
	stdout: 'pipe',
	stderr: 'pipe',
});
assert.equal(gitHead.exitCode, 0);
const sourceHead = gitHead.stdout.toString().trim();
const evidence = await realpath(
	await mkdtemp(join(tmpdir(), 'attachment-native-')),
);
console.log(`Attachment native evidence: ${evidence}`);
const desktop = join(evidence, 'desktop');
const native = join(desktop, 'src-tauri');
const profile = join(evidence, 'profile');
const identifier = `so.epicenter.attachment-acceptance.${randomUUID()}`;
const storeId = [...randomBytes(16)];
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
	EPICENTER_ACCEPTANCE_IDENTIFIER: identifier,
	EPICENTER_ACCEPTANCE_STORE: JSON.stringify(storeId),
};
let accountFixture;
let accountResult;
let report;
let assetFingerprint;
const accountUiObservations = {};
let runFailure;
let cleanupFailures = [];
const cleanupEvidence = [];
const accountMode = process.argv.includes('--account');
const identities = [{ identifier, storeId, profile }];
let nativeProcess;
let sequence = 0;
const observations =
	"window.acceptanceLogs=[];for(const level of ['debug','log','info','warn','error']){const original=console[level].bind(console);console[level]=(...values)=>{acceptanceLogs.push({level,values:values.map(value=>{try{return JSON.stringify(value,Object.getOwnPropertyNames(value??{}));}catch{return String(value)}})});original(...values)}}window.acceptanceErrors=[];window.addEventListener('error',event=>acceptanceErrors.push(String(event.error)));window.addEventListener('unhandledrejection',event=>acceptanceErrors.push(String(event.reason)));" +
	`const realFetch=window.fetch.bind(window);window.fetch=async(...args)=>{try{const response=await realFetch(...args);if(!response.ok)window.acceptanceLogs.push({level:'http-error',path:new URL(typeof args[0]==='string'||args[0] instanceof URL?args[0]:args[0].url,location.href).pathname,status:response.status,body:(await response.clone().text()).slice(0,2048)});return response}catch(error){window.acceptanceLogs.push({level:'fetch-error',path:new URL(typeof args[0]==='string'||args[0] instanceof URL?args[0]:args[0].url,location.href).pathname,error:String(error)});throw error}};`;
const checks = [];
const importMode = process.argv.includes('--import');
const processes = [];
async function run(command) {
	const child = Bun.spawn(command, {
		cwd: root,
		env: environment,
		stdout: 'inherit',
		stderr: 'inherit',
	});
	assert.equal(await child.exited, 0, command.join(' '));
}
async function until(label, predicate, timeout = 30_000) {
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
			if (error.code !== 'ENOENT') throw error;
		}
	});
	assert.equal(result.error, undefined, JSON.stringify(result));
	return result.value;
}
async function ui(expression) {
	const id = sequence + 1;
	return command('eval', {
		product: 'whispering',
		script: `(async()=>{try{const value=await(async()=>{${expression}})();await window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'catalog-acceptance',payload:{id:${id},value:value??null}});}catch(error){await window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'catalog-acceptance',payload:{id:${id},error:String(error),stack:error?.stack}});}})()`,
	});
}
async function click(selector, text) {
	await until(`control ${text ?? selector}`, () =>
		ui(
			`const element=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(element=>${text === undefined ? 'true' : `element.textContent.trim()===${JSON.stringify(text)}`});if(!element||element.disabled)return false;element.click();return true;`,
		),
	);
}
async function configureOfflineInference() {
	await click('a[href$="/settings/processing"]');
	await until('transcription picker', () =>
		ui(
			`const field=Array.from(document.querySelectorAll('[data-slot="field"]')).find(element=>element.textContent.includes('Transcription connection and model'));const button=field?.querySelector('button[role="combobox"]');if(!button)return false;button.click();return true;`,
		),
	);
	await click('[role="option"]', 'Connect a provider...');
	await click('[role="option"]', 'Custom URL');
	for (const [selector, value] of [
		['#conn-name', 'Offline attachment acceptance'],
		['#conn-url', `http://127.0.0.1:${port}/offline-inference/v1`],
		['input[aria-label="Model ID"]', 'offline-model'],
	]) {
		await until(`input ${selector}`, () =>
			ui(
				`const element=document.querySelector(${JSON.stringify(selector)});if(!element)return false;element.value=${JSON.stringify(value)};element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));return true;`,
			),
		);
	}
	await click('button', 'Add');
	await click('a', 'Home');
}
async function start() {
	await unlink(join(evidence, 'bun-exit.json')).catch((error) => {
		if (error.code !== 'ENOENT') throw error;
	});
	nativeProcess = Bun.spawn(
		[
			join(
				environment.CARGO_TARGET_DIR,
				'debug/examples/attachment_acceptance',
			),
		],
		{
			env: environment,
			stdout: Bun.file(join(evidence, `native-${processes.length}.log`)),
			stderr: Bun.file(join(evidence, `native-${processes.length}.stderr.log`)),
		},
	);
	await until('host listener', async () => {
		if (nativeProcess.exitCode !== null)
			throw new Error(`Native exited ${nativeProcess.exitCode}`);
		try {
			return (
				(await fetch(`http://127.0.0.1:${port}/_epicenter/ai/connections`))
					.status === 401
			);
		} catch {
			return false;
		}
	});
	processes.push(await command('launch', { product: 'whispering' }));
	await until('Whispering Home', () =>
		ui(
			'return Boolean(document.querySelector(\'a[href$="/settings/processing"]\'));',
		),
	);
}
async function stop() {
	await command('quit');
	assert.equal(
		await Promise.race([
			nativeProcess.exited,
			Bun.sleep(10_000).then(() => 'timeout'),
		]),
		0,
		'Native host exits cleanly',
	);
	assert.equal(
		await Bun.file(join(evidence, 'bun-exit.json')).json(),
		0,
		'Bun host exits cleanly',
	);
	await until('host listener stops', async () => {
		try {
			await fetch(`http://127.0.0.1:${port}/`);
			return false;
		} catch {
			return true;
		}
	});
}
async function selectLibrary(name) {
	await click('button', name);
	await until(`selected ${name} library`, () =>
		ui(
			`return Array.from(document.querySelectorAll('button')).some(element=>element.textContent.trim()===${JSON.stringify(name)}&&element.getAttribute('aria-pressed')==='true');`,
		),
	);
	await until('library document ready', () =>
		ui(
			'return Boolean(document.querySelector(\'a[href$="/settings/processing"]\'));',
		),
	);
}
async function importAudio(name = 'attachment-native.wav') {
	await click('a', 'Home');
	await click('button[aria-label="Switch to upload file"]');
	const sampleRate = 16000;
	const samples = sampleRate * 2;
	const bytes = Buffer.alloc(44 + samples * 2);
	bytes.write('RIFF');
	bytes.writeUInt32LE(bytes.length - 8, 4);
	bytes.write('WAVEfmt ', 8);
	bytes.writeUInt32LE(16, 16);
	bytes.writeUInt16LE(1, 20);
	bytes.writeUInt16LE(1, 22);
	bytes.writeUInt32LE(sampleRate, 24);
	bytes.writeUInt32LE(sampleRate * 2, 28);
	bytes.writeUInt16LE(2, 32);
	bytes.writeUInt16LE(16, 34);
	bytes.write('data', 36);
	bytes.writeUInt32LE(samples * 2, 40);
	for (let index = 0; index < samples; index++)
		bytes.writeInt16LE(
			Math.round(Math.sin((index * 2 * Math.PI * 440) / sampleRate) * 2000),
			44 + index * 2,
		);
	await Bun.write(join(evidence, name), bytes);
	await until('audio file input', () =>
		ui(
			`const input=document.querySelector('input[type="file"]');if(!input)return false;const bytes=Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}),char=>char.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],${JSON.stringify(name)},{type:'audio/wav'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true;`,
		),
	);
	return audio();
}
async function audio() {
	return until('local audio element', () =>
		ui(
			`const audio=document.querySelector('audio');return audio&&Number.isFinite(audio.duration)&&audio.duration>0?{src:audio.currentSrc,duration:audio.duration,readyState:audio.readyState}:null;`,
		),
	);
}
async function play() {
	const before = await audio();
	await ui(
		`const audio=document.querySelector('audio');audio.currentTime=0;await audio.play();return true;`,
	);
	const played = await until('audio playback advances', () =>
		ui(
			`const audio=document.querySelector('audio');return audio.currentTime>0.25?{currentTime:audio.currentTime,paused:audio.paused,error:audio.error?.message??null}:null;`,
		),
	);
	assert.equal(played.error, null);
	await ui(`document.querySelector('audio').pause();return true;`);
	return { ...before, ...played };
}
async function observeAccountUi(stage) {
	accountUiObservations[stage] = await ui(
		'return {errors:window.acceptanceErrors,logs:window.acceptanceLogs};',
	);
}
async function fingerprint(directory) {
	const paths = (await files(directory)).sort();
	const hash = new Bun.CryptoHasher('sha256');
	for (const path of paths) {
		hash.update(path.slice(directory.length + 1));
		hash.update('\0');
		hash.update(await readFile(path));
		hash.update('\0');
	}
	return { directory, files: paths.length, sha256: hash.digest('hex') };
}
async function savedFiles(rootDirectory, library) {
	const paths = (await files(join(rootDirectory, 'apps'))).filter(
		(path) =>
			path.endsWith('/data') &&
			path.includes(library === 'local' ? '/local/blobs/' : '/accounts/'),
	);
	return Promise.all(
		paths.map(async (path) => ({
			path,
			sha256: new Bun.CryptoHasher('sha256')
				.update(await readFile(path))
				.digest('hex'),
			metadata: await Bun.file(path.replace(/data$/, 'metadata.json')).json(),
		})),
	);
}
async function files(directory) {
	const result = [];
	for (const entry of await readdir(directory, { withFileTypes: true }).catch(
		(error) => {
			if (error.code === 'ENOENT') return [];
			throw error;
		},
	)) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...(await files(path)));
		else result.push(path);
	}
	return result;
}
try {
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
	await run([
		'rsync',
		'-a',
		`${root}/apps/epicenter/dist/`,
		`${desktop}/dist/`,
	]);
	assetFingerprint = await fingerprint(join(desktop, 'dist/whispering'));
	await Bun.write(
		join(evidence, 'assets.json'),
		JSON.stringify(assetFingerprint, null, 2),
	);
	const config = await Bun.file(join(native, 'tauri.conf.json')).json();
	config.identifier = identifier;
	config.productName = 'Attachment acceptance';
	config.build = { frontendDist: 'frontend-placeholder' };
	config.bundle = { active: false, icon: ['icons/icon.png'] };
	config.app.security.capabilities = [
		'trusted-app-windows-development',
		'home-launch-application-development',
		'trusted-whispering-native-development',
		'trusted-whispering-overlay-development',
		'attachment-acceptance',
	];
	await Bun.write(join(native, 'tauri.conf.json'), JSON.stringify(config));
	await Bun.write(
		join(native, 'capabilities/attachment-acceptance.json'),
		JSON.stringify({
			identifier: 'attachment-acceptance',
			local: false,
			windows: ['whispering'],
			remote: { urls: [`http://127.0.0.1:${port}`] },
			permissions: ['core:event:allow-emit'],
		}),
	);
	let rust = await Bun.file(join(native, 'src/lib.rs')).text();
	assert(rust.includes('specta_builder.mount_events(app);'));
	rust = rust.replace(
		'specta_builder.mount_events(app);',
		'specta_builder.mount_events(app);\n start_catalog_acceptance(app.handle());',
	);
	rust = rust.replaceAll(
		'.initialization_script(initialization_script)',
		`.data_store_identifier(serde_json::from_str::<[u8;16]>(&std::env::var("EPICENTER_ACCEPTANCE_STORE").unwrap()).unwrap()).initialization_script(r#"${observations}"#).initialization_script(initialization_script)`,
	);
	assert(rust.includes('let _ = process.child.wait();'));
	rust = rust.replace(
		'let _ = process.child.wait();',
		'let status = process.child.wait().unwrap(); fs::write(std::path::Path::new(&std::env::var("EPICENTER_ACCEPTANCE_DIR").unwrap()).join("bun-exit.json"), serde_json::to_string(&status.code()).unwrap()).unwrap();',
	);
	assert(rust.includes('.build(tauri::generate_context!())'));
	rust = rust.replace(
		'.build(tauri::generate_context!())',
		'.build({let mut context=tauri::generate_context!();context.config_mut().identifier=std::env::var("EPICENTER_ACCEPTANCE_IDENTIFIER").unwrap();context})',
	);
	let driver = await Bun.file(
		join(import.meta.dir, 'shared-ai-catalog-native/driver.rs'),
	).text();
	driver = driver.replace(
		'use tauri::Listener;',
		'use tauri::Listener; if let Ok(path)=std::env::var("EPICENTER_ACCEPTANCE_AUTH_CELL") { write_auth_cell(&app.config().identifier,Some(fs::read_to_string(path).unwrap())).unwrap(); }',
	);
	driver = driver.replace(
		'"quit" => {',
		'"delete-auth" => { write_auth_cell(&app.config().identifier,None)?; Ok(serde_json::Value::Bool(true)) }\n "quit" => {',
	);
	rust += driver;
	await Bun.write(join(native, 'src/lib.rs'), rust);
	const overlayPath = join(native, 'src/overlay.rs');
	const overlay = await Bun.file(overlayPath).text();
	assert(overlay.includes('.initialization_script(initialization_script)'));
	await Bun.write(
		overlayPath,
		overlay.replace(
			'.initialization_script(initialization_script)',
			`.data_store_identifier(serde_json::from_str::<[u8;16]>(&std::env::var("EPICENTER_ACCEPTANCE_STORE").unwrap()).unwrap()).initialization_script(r#"${observations}"#).initialization_script(initialization_script)`,
		),
	);
	await mkdir(join(native, 'examples'), { recursive: true });
	await Bun.write(
		join(native, 'examples/attachment_acceptance.rs'),
		'fn main() { epicenter_lib::run(); }',
	);
	await run([
		'cargo',
		'build',
		'--manifest-path',
		join(native, 'Cargo.toml'),
		'--example',
		'attachment_acceptance',
	]);
	await start();
	await configureOfflineInference();
	await Bun.write(
		join(evidence, 'before-capture.txt'),
		await ui('return document.body.innerText;'),
	);
	if (importMode) {
		await importAudio();
	} else {
		await click('button[aria-label^="Start recording"]');
		await until('physical microphone recording', () =>
			ui(
				'return Boolean(document.querySelector(\'button[aria-label^="Stop recording"][aria-pressed="true"]\'));',
			),
		);
		await Bun.sleep(2_000);
		await click('button[aria-label^="Stop recording"]');
		await until('Saved on this device', () =>
			ui('return document.body.innerText.includes("Saved on this device");'),
		);
	}
	const saved = await audio();
	assert(saved.duration >= 1, 'Saved audio contains at least one second');
	checks.push(
		importMode
			? 'Actual built Whispering UI imports generated two-second WAV and exposes playable saved audio'
			: 'Actual built Whispering UI starts and stops the physical microphone, then reports Saved on this device',
	);
	await Bun.write(
		join(evidence, 'after-save.txt'),
		await ui('return document.body.innerText;'),
	);
	const firstPlayback = await play();
	await click('a', 'Recordings');
	await until('local presence UI', () =>
		ui(
			'return document.body.innerText.includes("Audio stays in this device\'s local library.")&&Boolean(document.querySelector("audio"));',
		),
	);
	const presence = await ui('return document.body.innerText;');
	assert(!presence.includes('Pause downloads'));
	await Bun.write(join(evidence, 'presence.txt'), presence);
	checks.push(
		'Recordings UI shows local presence, local-library explanation, and no inapplicable account transfer controls',
	);
	const durableFiles = await files(join(profile, 'apps'));
	assert(durableFiles.length > 0);
	const beforeRestart = await ui('return performance.timeOrigin;');
	await stop();
	await start();
	const afterRestart = await ui('return performance.timeOrigin;');
	assert.notEqual(beforeRestart, afterRestart);
	assert.notEqual(processes[0].nativePid, processes[1].nativePid);
	assert.notEqual(processes[0].bunPid, processes[1].bunPid);
	await click('a', 'Home');
	const secondPlayback = await play();
	assert.equal(secondPlayback.duration, firstPlayback.duration);
	checks.push(
		'Independent native and Bun processes reopen the same isolated profile; saved Local audio plays and time advances',
	);
	const errors = await ui('return window.acceptanceErrors;');
	assert.deepEqual(
		errors.filter((error) => !error.includes('View transition was skipped')),
		[],
	);
	await stop();
	if (accountMode) {
		assert(
			importMode,
			'Account journey currently requires --import (physical input remains unavailable)',
		);
		const { startNativeAccountFixture } = await import(
			'./attachment-native-account.mjs'
		);
		accountFixture = await startNativeAccountFixture({
			directory: join(evidence, 'account-fixture'),
		});
		const seed = async (cell) => {
			const path = join(evidence, 'auth-cell.json');
			await Bun.write(path, cell);
			environment.EPICENTER_ACCEPTANCE_AUTH_CELL = path;
		};
		await seed(accountFixture.authCells.A);
		await start();
		delete environment.EPICENTER_ACCEPTANCE_AUTH_CELL;
		await selectLibrary('Local');
		await click('a', 'Home');
		await audio();
		checks.push('A retains its Local audio after authentication');
		assert.equal(
			accountFixture.requests.length,
			0,
			'Authentication never adopts Local attachments',
		);
		await selectLibrary('Personal');
		await until('new Personal library empty', () =>
			ui('return document.querySelector("audio")===null;'),
		);
		await configureOfflineInference();
		await accountFixture.setOffline(true);
		await importAudio('account-native.wav');
		await click('a', 'Recordings');
		await until('account audio saved while disconnected', () =>
			ui(
				'return document.body.innerText.includes("Audio sync:")&&Boolean(document.querySelector("audio"));',
			),
		);
		await Bun.write(
			join(evidence, 'account-a-offline.txt'),
			await ui('return document.body.innerText;'),
		);
		assert.equal(
			accountFixture.requests.filter((request) => request.method === 'PUT')
				.length,
			0,
			'Disconnected save uploads nothing',
		);
		await stop();
		await start();
		await click('a', 'Home');
		const aOfflinePlayback = await play();
		await observeAccountUi('aOfflineRestart');
		assert.equal(
			accountFixture.requests.filter((request) => request.method === 'PUT')
				.length,
			0,
			'Disconnected restart uploads nothing',
		);
		await click('a', 'Recordings');
		await click('button', 'Pause downloads');
		await accountFixture.setOffline(false);
		await until(
			'A automatic attachment upload',
			() => accountFixture.requests.some((request) => request.method === 'PUT'),
			60_000,
		);
		await click('a', 'Recordings');
		await until(
			'A transfers settled',
			() =>
				ui(
					'if(document.body.innerText.includes("1 need attention."))throw new Error("Attachment transfer failed in actual UI");return document.body.innerText.includes("Audio sync: 0 transferring, 0 waiting, 0 need attention.");',
				),
			60_000,
		);
		await click('button', 'Resume downloads');
		await observeAccountUi('aAfterUpload');
		const aSaved = await savedFiles(profile, 'personal');
		assert.equal(
			aSaved.length,
			1,
			'A account contains exactly its new saved file',
		);
		const afterA = accountFixture.requests.length;
		await command('delete-auth');
		await stop();
		const b = {
			identifier: `so.epicenter.attachment-acceptance.${randomUUID()}`,
			storeId: [...randomBytes(16)],
			profile: join(evidence, 'profile-b'),
		};
		identities.push(b);
		environment.EPICENTER_DATA_DIR = b.profile;
		environment.EPICENTER_ACCEPTANCE_IDENTIFIER = b.identifier;
		environment.EPICENTER_ACCEPTANCE_STORE = JSON.stringify(b.storeId);
		accountFixture.holdDownloads(true);
		await seed(accountFixture.authCells.B);
		await start();
		delete environment.EPICENTER_ACCEPTANCE_AUTH_CELL;
		await selectLibrary('Personal');
		await click('a', 'Recordings');
		await until(
			'B starts held automatic download',
			() =>
				accountFixture.requests
					.slice(afterA)
					.some((request) => request.method === 'GET' && request.held),
			60_000,
		);
		await click('button', 'Pause downloads');
		await until('downloads paused control', () =>
			ui('return document.body.innerText.includes("Resume downloads");'),
		);
		assert.equal(
			await ui('return Boolean(document.querySelector("audio"));'),
			false,
			'B has no playable file while transfer held',
		);
		await until('pause drains held GET', () =>
			accountFixture.requests
				.slice(afterA)
				.some((request) => request.held && request.aborted),
		);
		const pausedGets = accountFixture.requests
			.slice(afterA)
			.filter((request) => request.method === 'GET').length;
		await click('button', 'Retry transfers');
		await Bun.sleep(1_000);
		assert.equal(
			accountFixture.requests
				.slice(afterA)
				.filter((request) => request.method === 'GET').length,
			pausedGets,
			'Retry while paused starts no GET',
		);
		assert.equal(
			await ui('return Boolean(document.querySelector("audio"));'),
			false,
			'Paused B remains unavailable after Retry',
		);
		accountFixture.holdDownloads(false);
		await click('button', 'Resume downloads');
		await until(
			'B automatic audio arrival before Play',
			() =>
				ui(
					'const audio=document.querySelector("audio");return audio&&Number.isFinite(audio.duration)&&audio.duration>0;',
				),
			60_000,
		);

		await until('downloads resumed control', () =>
			ui('return document.body.innerText.includes("Pause downloads");'),
		);
		await Bun.write(
			join(evidence, 'account-b-before-play.txt'),
			await ui('return document.body.innerText;'),
		);
		assert.equal(
			accountFixture.requests
				.slice(afterA)
				.filter((request) => request.method === 'PUT').length,
			0,
			'Downloaded B files are never uploaded',
		);
		await until('B transfer settled before offline playback', () =>
			ui(
				'return document.body.innerText.includes("Audio sync: 0 transferring, 0 waiting, 0 need attention.");',
			),
		);
		await observeAccountUi('bBeforePlay');
		const bSaved = await savedFiles(b.profile, 'personal');
		assert.equal(bSaved.length, 1, 'B has exactly the delivered account file');
		assert.equal(
			bSaved[0].sha256,
			aSaved[0].sha256,
			'B bytes equal A saved bytes',
		);
		assert.equal(
			'originGeneration' in bSaved[0].metadata.attachment,
			false,
			'Downloaded B bytes have no local origin',
		);
		await accountFixture.setOffline(true);
		const attachmentControls = () =>
			accountFixture.authorityRequests.filter((request) =>
				request.path.includes('/attachments'),
			).length;
		const beforeControlPlay = attachmentControls();
		const beforePlay = accountFixture.requests.length;
		const bPlayback = await play();
		assert.equal(
			accountFixture.requests.length,
			beforePlay,
			'Offline B playback sends no object request',
		);
		await stop();
		await start();
		await click('a', 'Recordings');
		const bRestartPlayback = await play();
		await observeAccountUi('bOfflineRestart');
		assert.equal(
			accountFixture.requests.length,
			beforePlay,
			'B offline restart/playback sends no object request',
		);
		assert.equal(
			attachmentControls(),
			beforeControlPlay,
			'B playback and offline restart request no attachment tickets or finalize',
		);
		await command('delete-auth');
		await stop();
		accountResult = {
			serverUrl: accountFixture.serverUrl,
			aOfflinePlayback,
			aSaved,
			bSaved,
			bPlayback,
			bRestartPlayback,
			objectRequests: accountFixture.requests,
			authorityRequests: accountFixture.authorityRequests,
			afterA,
			keychainAuthCleared: true,
			uiObservations: accountUiObservations,
			limits:
				'Authenticated real self-host HTTP/WebSocket plus HTTP object fixture; no real object-provider conformance or physical microphone capture',
		};
		checks.push(
			'A Personal import saves offline, survives process restart offline, and automatically uploads after reconnection',
		);
		checks.push(
			'Separately persisted native B receives audio before Play, exposes pause/retry/resume, and plays offline before and after process restart without object requests or uploads',
		);
	}
	report = {
		passed: true,
		sourceHead,
		identities,
		account: accountResult,
		mode: importMode ? 'generated WAV import' : 'physical microphone',
		localObservedUiErrors: errors,
		assetFingerprint,
		checks,
		identifier,
		storeId,
		processes,
		firstPlayback,
		secondPlayback,
		durableFiles,
		evidence,
		scope:
			'Actual built Whispering UI, capture source reported by mode, Local destination without an authenticated account, selected unavailable loopback inference endpoint, clean native+Bun process restart, and HTML audio playback. DOM events drive controls; audio.play drives the native audio element.',
		gaps: [
			...(!accountMode
				? [
						'Authenticated separately persisted native A/B account synchronization remains untested by this local harness.',
					]
				: []),
			...(importMode
				? ['Physical microphone capture is not exercised by --import.']
				: []),
			'No real object provider is exercised.',
			'No physical network disconnection, power loss, native file chooser, or signed release packaging is claimed.',
		],
	};
} catch (error) {
	if (nativeProcess?.exitCode === null) {
		try {
			await Bun.write(
				join(evidence, 'failure-dom.txt'),
				await ui('return document.body.innerText;'),
			);
			await Bun.write(
				join(evidence, 'failure-observations.json'),
				JSON.stringify(
					await ui(
						'return {logs:window.acceptanceLogs,errors:window.acceptanceErrors,buttons:Array.from(document.querySelectorAll("button")).map(element=>({text:element.textContent,label:element.getAttribute("aria-label"),disabled:element.disabled,pressed:element.getAttribute("aria-pressed")}))};',
					),
					null,
					2,
				),
			);
		} catch {}
	}
	await Bun.write(
		join(evidence, 'failure.json'),
		JSON.stringify(
			{
				error: String(error),
				stack: error.stack,
				checks,
				processes,
				identities,
				account: accountFixture
					? {
							requests: accountFixture.requests,
							authorityRequests: accountFixture.authorityRequests,
						}
					: null,
			},
			null,
			2,
		),
	);
	runFailure = error;
} finally {
	if (nativeProcess?.exitCode === null) {
		try {
			await command('delete-auth');
			await command('quit');
			await Promise.race([nativeProcess.exited, Bun.sleep(5_000)]);
		} catch {}
		if (nativeProcess.exitCode === null) nativeProcess.kill();
		await nativeProcess.exited;
	}
	const cleanup = await Promise.allSettled([
		accountFixture?.close(),
		until(
			'owned Bun sidecars exited',
			() =>
				processes.every(({ bunPid }) => {
					try {
						process.kill(bunPid, 0);
						return false;
					} catch (error) {
						if (error.code === 'ESRCH') return true;
						throw error;
					}
				}),
			10_000,
		),
		until(
			'owned host listener stopped',
			async () => {
				try {
					await fetch(`http://127.0.0.1:${port}/`, {
						signal: AbortSignal.timeout(1000),
					});
					return false;
				} catch {
					return true;
				}
			},
			10_000,
		),
		(async () => {
			for (const identity of identities) {
				const remove = Bun.spawn(
					[
						'security',
						'delete-generic-password',
						'-s',
						identity.identifier,
						'-a',
						'auth-grant',
					],
					{ stdout: 'ignore', stderr: 'pipe' },
				);
				const status = await remove.exited;
				assert(
					[0, 44].includes(status),
					`Could not clear disposable keychain ${identity.identifier}: ${await new Response(remove.stderr).text()}`,
				);
				const read = Bun.spawn(
					[
						'security',
						'find-generic-password',
						'-s',
						identity.identifier,
						'-a',
						'auth-grant',
					],
					{ stdout: 'ignore', stderr: 'ignore' },
				);
				assert.equal(
					await read.exited,
					44,
					'Disposable auth keychain entry is absent',
				);
				cleanupEvidence.push({
					identifier: identity.identifier,
					authEntryAbsent: true,
				});
			}
		})(),
		unlink(join(evidence, 'auth-cell.json')).catch((error) => {
			if (error.code !== 'ENOENT') throw error;
		}),
	]);
	await Bun.write(
		join(evidence, 'cleanup.json'),
		JSON.stringify(
			{
				keychain: cleanupEvidence,
				results: cleanup.map((result) => result.status),
			},
			null,
			2,
		),
	);
	cleanupFailures = cleanup
		.filter((result) => result.status === 'rejected')
		.map((result) => result.reason);
}
if (runFailure || cleanupFailures.length)
	throw new AggregateError(
		[...(runFailure ? [runFailure] : []), ...cleanupFailures],
		'Native acceptance or cleanup failed',
	);
if (report) {
	report.cleanup = {
		keychain: cleanupEvidence,
		authCellFileRemoved: true,
		fixtureClosed: true,
		nativeProcessesExited: true,
	};
	await Bun.write(
		join(evidence, 'result.json'),
		JSON.stringify(report, null, 2),
	);
	console.log(JSON.stringify(report, null, 2));
}
