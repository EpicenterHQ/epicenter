/**
 * Explicit physical microphone and real WebView interruption evidence.
 * Runs isolated native hosts with temporary storage; kills only its own child
 * after that host confirms a physical capture is active, then reopens input.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const repo = new URL('../../../', import.meta.url).pathname;
const build = Bun.spawn(
	[
		'cargo',
		'build',
		'--manifest-path',
		'apps/epicenter/src-tauri/Cargo.toml',
		'--example',
		'capture_document_evidence',
	],
	{ cwd: repo, stdout: 'inherit', stderr: 'inherit' },
);
if (await build.exited)
	throw new Error('Native capture evidence did not build.');
const root = await mkdtemp(resolve(tmpdir(), 'epicenter-physical-capture-'));
const binary = resolve(
	repo,
	'apps/epicenter/src-tauri/target/debug/examples/capture_document_evidence',
);
const children: ReturnType<typeof Bun.spawn>[] = [];
try {
	const ready = Promise.withResolvers<void>();
	const first = Bun.spawn([binary], {
		cwd: repo,
		env: {
			...process.env,
			EPICENTER_CAPTURE_EVIDENCE_ROOT: root,
			EPICENTER_CAPTURE_EVIDENCE_MODE: 'interrupt',
		},
		stdout: 'inherit',
		stderr: 'pipe',
	});
	children.push(first);
	const reading = (async () => {
		let output = '';
		const reader = first.stderr.getReader();
		const decoder = new TextDecoder();
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			const text = decoder.decode(chunk.value, { stream: true });
			process.stderr.write(text);
			output += text;
			if (
				output.includes(
					'NATIVE_WEBVIEW_READY_FOR_INTERRUPTION physical_capture_active=true',
				)
			)
				ready.resolve();
		}
	})();
	await Promise.race([
		ready.promise,
		first.exited.then((code) => {
			throw new Error(
				`Native host exited before physical interruption: ${code}`,
			);
		}),
	]);
	first.kill('SIGKILL');
	await first.exited;
	await reading;
	console.log(
		'Killed the owned native host while its physical capture was active.',
	);
	const second = Bun.spawn([binary], {
		cwd: repo,
		env: {
			...process.env,
			EPICENTER_CAPTURE_EVIDENCE_ROOT: root,
			EPICENTER_CAPTURE_EVIDENCE_MODE: 'recover',
		},
		stdout: 'inherit',
		stderr: 'inherit',
	});
	children.push(second);
	if (await second.exited)
		throw new Error('Native capture did not recover after host interruption.');
	console.log(
		'Physical input reopened in a new native process; the saved file survived and decoded locally.',
	);
} finally {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill();
		await child.exited;
	}
	await rm(root, { recursive: true, force: true });
}
