import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Applications may inspect the *readiness and capabilities* of the local
 * transcription route, and never model identity, catalog inventory, or
 * selection (ADR-0180).
 *
 * The generated bindings are where that boundary is real: they are the complete
 * list of commands this app can name, regenerated from Rust, so a command
 * reappearing in Whispering's facade is exactly how the boundary would erode.
 * Reading the facade as text rather than importing it keeps this test off the
 * Tauri runtime, which does not exist under `bun test`.
 */
const facade = readFileSync(
	fileURLToPath(new URL('../tauri.tauri.ts', import.meta.url)),
	'utf8',
);

/** The `transcription` namespace block of the Tauri facade. */
const transcriptionNamespace = facade.slice(
	facade.indexOf('const transcription = {'),
	facade.indexOf('};', facade.indexOf('const transcription = {')),
);

describe('the local transcription boundary Whispering sits behind', () => {
	it('reaches no administration or identity command', () => {
		// `getActiveModel` is in this list on purpose: model identity is
		// administration data, so even the read is Home's.
		for (const command of [
			'getActiveModel',
			'setActiveModel',
			'takePendingHomeSection',
			'listModels',
			'downloadModel',
			'deleteModel',
			'cancelDownload',
			'getUnloadPolicy',
			'setUnloadPolicy',
		]) {
			expect(transcriptionNamespace).not.toContain(command);
		}
	});

	it('reaches readiness, transcription, and shell navigation', () => {
		for (const command of [
			'getLocalTranscriptionReadiness',
			'transcribeRecording',
			'prewarmModel',
			'openHomeTranscription',
		]) {
			expect(transcriptionNamespace).toContain(command);
		}
	});

});
