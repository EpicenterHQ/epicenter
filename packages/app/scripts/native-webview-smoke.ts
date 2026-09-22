/**
 * Real macOS Wry WebView, production inference capability, SDK adapter, and cached model.
 * Builds only a temporary native example against the existing Cargo target cache.
 * No account or microphone opens; the WebView is incognito and settings are temporary.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../../../', import.meta.url).pathname;
assert.equal(
	globalThis.process.platform,
	'darwin',
	'This native WebView fixture runs on macOS',
);
const audioPath = globalThis.process.env.EPICENTER_NATIVE_AUDIO;
if (!audioPath)
	throw new Error('Set EPICENTER_NATIVE_AUDIO to an existing speech WAV.');
assert(await Bun.file(audioPath).exists());
const temporary = await mkdtemp(join(tmpdir(), 'epicenter-native-webview-'));
const native = join(temporary, 'native');
const token = randomBytes(24).toString('hex');
const origin = 'http://127.0.0.1:39130';
const base = `/${token}/`;
const resultPath = join(temporary, 'result.json');
const result = Promise.withResolvers<Record<string, unknown>>();
let nativeProcess: ReturnType<typeof Bun.spawn> | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;

const pageSource = `
import { invoke, isTauri } from '${root}packages/app/node_modules/@tauri-apps/api/core.js';
import { createInference } from '${root}packages/app/src/inference.ts';
import { createNativeInferenceTransport } from '${root}packages/app/src/native-ai.ts';
const violations = [];
document.addEventListener('securitypolicyviolation', event => violations.push(event.violatedDirective));
const lifetime = new AbortController();
const owner = createInference(createNativeInferenceTransport());
try {
 if (!isTauri()) throw new Error('Real Tauri IPC is absent');
 const client = owner.client;
 const model = 'handy-computer/whisper-tiny-gguf@main/whisper-tiny-Q8_0.gguf';
 const models = await client.models.list();
 if (!models.data.some(entry => entry.id === model)) throw new Error('Whisper Tiny is not cached');
 const file = new File([await (await fetch('./audio.wav')).arrayBuffer()], 'speech.wav', {type:'audio/wav'});
 const transcript = await client.audio.transcriptions.create({file, model, language:'en', prompt:'The application closes its inference clients.'});
 if (!transcript.text.trim()) throw new Error('Speech produced no text');
 if (transcript.model !== model || transcript.applied.language !== 'en' || transcript.applied.initialPrompt !== true) throw new Error('Native model or applied hints changed');
 const empty = await client.audio.transcriptions.create({file:new File([], 'empty.wav'), model});
 if (empty.text !== '' || 'model' in empty || 'applied' in empty) throw new Error('Empty audio claims inference');
 let adminDenied = false;
 try { await invoke('get_active_model'); } catch (error) { adminDenied = String(error).includes('not allowed'); }
 if (!adminDenied) throw new Error('Production app capability did not refuse administration');
 lifetime.abort();
 await owner.close();
 let retainedRejected = false;
 try { await client.models.list(); } catch { retainedRejected = true; }
 if (!retainedRejected) throw new Error('Retained client survived retirement');
 if (violations.length) throw new Error('CSP violations: '+violations.join(', '));
 await fetch('./report', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ok:true, runtime:'real Wry WebView', inference:'real cached transcribe.cpp', model, byteLength:file.size, transcript, empty, adminDenied, retainedRejected, cspViolations:violations})});
} catch(error) {
 await fetch('./report', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ok:false,error:String(error),stack:error?.stack,violations})});
} finally { lifetime.abort(); await owner.close(); }
`;
const html =
	'<!doctype html><html><head><meta charset="utf-8"><title>Native inference acceptance</title></head><body><script type="module" src="./main.js"></script></body></html>';
// Execute the existing policy constructor without exporting a test-only production API.
const serverSource = await Bun.file(
	join(root, 'apps/epicenter/src/server.ts'),
).text();
const policySource = serverSource.slice(
	serverSource.indexOf('function contentSecurityPolicy('),
	serverSource.indexOf('\nasync function readJsonObject('),
);
assert(policySource.startsWith('function contentSecurityPolicy('));
const policyJavaScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
	policySource,
);
const csp: string = new Function(
	'createHash',
	'page',
	`${policyJavaScript}; return contentSecurityPolicy(page);`,
)(createHash, html);
let script = '';
const server = Bun.serve({
	hostname: '127.0.0.1',
	port: 39130,
	async fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === base && request.method === 'GET')
			return new Response(html, {
				headers: {
					'content-type': 'text/html',
					'content-security-policy': csp,
				},
			});
		if (path === `${base}main.js` && request.method === 'GET')
			return new Response(script, {
				headers: { 'content-type': 'text/javascript' },
			});
		if (path === `${base}audio.wav` && request.method === 'GET')
			return new Response(Bun.file(audioPath));
		if (
			path === `${base}report` &&
			request.method === 'POST' &&
			request.headers.get('origin') === origin
		) {
			const report = await request.json();
			await Bun.write(resultPath, JSON.stringify(report));
			result.resolve(report);
			return new Response(null, { status: 204 });
		}
		return new Response(null, { status: 404 });
	},
});

try {
	await mkdir(join(native, 'examples'), { recursive: true });
	const copied = Bun.spawn(
		[
			'rsync',
			'-a',
			'--exclude=target',
			'--exclude=binaries',
			'--exclude=transcribe-libs',
			`${root}apps/epicenter/src-tauri/`,
			`${native}/`,
		],
		{ stdout: 'inherit', stderr: 'inherit' },
	);
	assert.equal(await copied.exited, 0);
	const config = await Bun.file(join(native, 'tauri.conf.json')).json();
	config.identifier = 'so.epicenter.native-ai-evidence';
	config.productName = 'Native AI Evidence';
	config.build = { frontendDist: 'frontend-placeholder' };
	config.bundle = { active: false, icon: ['icons/icon.png'] };
	config.app.security.capabilities = ['trusted-app-windows-production'];
	await Bun.write(join(native, 'tauri.conf.json'), JSON.stringify(config));
	await Bun.write(
		join(native, 'examples/ai_runtime_webview.rs'),
		`
use epicenter_lib::transcription::{LocalTranscriptionSettings, ModelCache, UnloadPolicy};
use std::path::PathBuf;
use tauri::{WebviewUrl, WebviewWindowBuilder};
fn main() {
 let directory = PathBuf::from(std::env::var("EPICENTER_EVIDENCE_DIR").unwrap());
 let settings_path = directory.join("local-transcription.json");
 let cache = ModelCache::new(LocalTranscriptionSettings::load(settings_path.clone()));
 cache.settings().set_unload_policy(UnloadPolicy::Immediately).unwrap();
 let initial_settings = std::fs::read(&settings_path).unwrap();
 let observed_cache = cache.clone();
 let result_path = directory.join("result.json");
 tauri::Builder::default()
  .enable_macos_default_menu(false)
  .plugin(tauri_plugin_http::init())
  .manage(cache)
  .invoke_handler(tauri::generate_handler![epicenter_lib::transcription::list_inference_models,epicenter_lib::transcription::transcribe_audio_bytes,epicenter_lib::transcription::get_active_model])
  .setup(move |app| {
   WebviewWindowBuilder::new(app, "whispering", WebviewUrl::External(std::env::var("EPICENTER_EVIDENCE_URL").unwrap().parse().unwrap()))
    .title("Native inference acceptance").incognito(true).visible(false).build()?;
   let handle = app.handle().clone();
   std::thread::spawn(move || {
    for _ in 0..600 {
     if result_path.exists() {
      assert_eq!(std::fs::read(&settings_path).unwrap(), initial_settings);
      assert!(observed_cache.settings().active_model_id().is_none());
      println!("Native WebView settings unchanged; shutting down.");
      handle.exit(0); return;
     }
     std::thread::sleep(std::time::Duration::from_millis(100));
    }
    eprintln!("Native WebView did not report within sixty seconds.");
    handle.exit(2);
   });
   Ok(())
  })
  .run(tauri::generate_context!()).expect("real Tauri runtime");
}
`,
	);
	const pagePath = join(temporary, 'page.ts');
	await Bun.write(pagePath, pageSource);
	const built = await Bun.build({
		entrypoints: [pagePath],
		target: 'browser',
		format: 'esm',
	});
	assert(built.success, String(built.logs));
	const output = built.outputs[0];
	assert(output, 'Browser bundle was emitted');
	script = await output.text();
	const environment = {
		...globalThis.process.env,
		CARGO_TARGET_DIR: join(root, 'apps/epicenter/src-tauri/target'),
		EPICENTER_EVIDENCE_DIR: temporary,
		EPICENTER_EVIDENCE_URL: `${origin}${base}`,
	};
	nativeProcess = Bun.spawn(
		[
			'cargo',
			'build',
			'--manifest-path',
			join(native, 'Cargo.toml'),
			'--example',
			'ai_runtime_webview',
		],
		{ env: environment, stdout: 'inherit', stderr: 'inherit' },
	);
	timeout = setTimeout(() => nativeProcess?.kill(), 180_000);
	assert.equal(
		await nativeProcess.exited,
		0,
		'Temporary native example builds',
	);
	clearTimeout(timeout);
	nativeProcess = Bun.spawn(
		[
			join(
				root,
				'apps/epicenter/src-tauri/target/debug/examples/ai_runtime_webview',
			),
		],
		{ env: environment, stdout: 'inherit', stderr: 'inherit' },
	);
	timeout = setTimeout(() => nativeProcess?.kill(), 75_000);
	const report = await Promise.race([
		result.promise,
		nativeProcess.exited.then((code) => {
			throw new Error(`WebView exited (${code}) before its report`);
		}),
	]);
	console.log(JSON.stringify(report));
	assert.equal(report.ok, true, 'Real WebView inference completed');
	assert.equal(
		await nativeProcess.exited,
		0,
		'Real WebView shuts down cleanly',
	);
} finally {
	clearTimeout(timeout);
	if (nativeProcess?.exitCode === null) {
		nativeProcess.kill();
		await nativeProcess.exited;
	}
	await server.stop(true);
	await rm(temporary, { recursive: true, force: true });
}
