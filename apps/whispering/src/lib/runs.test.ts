/**
 * Run Tests
 *
 * A transcription run over a stand-in folder and sender: what a failed
 * request says about whether anything was sent.
 *
 * Key behaviors:
 * - A request refused before it left (not sent, its endpoint gone or
 *   moved) says nothing was sent
 * - A request that was made and brought back no transcript says why in the
 *   request's own words, and never that nothing was sent
 * - Neither keeps a transcript
 */
import { expect, test } from 'bun:test';
import { Err, Ok } from 'wellcrafted/result';
import { expectErr } from 'wellcrafted/testing';
import { memoryFiles } from './files/memory.js';
import { openFolder } from './folder.js';
import { InferenceError, type Target } from './inference.js';
import { createRuns } from './runs.js';

const target: Target = {
	endpoint: 'stub',
	model: 'whisper-1',
	name: 'Provider',
	address: 'http://127.0.0.1:18080/v1',
};

async function runWith(error: InferenceError) {
	const folder = openFolder(
		memoryFiles({ 'recordings/a.webm': new Uint8Array([1]) }),
	);
	const run = await createRuns({
		folder,
		chosen: () => Ok(target),
		transcribe: async () => Err(error),
		refused: () => undefined,
	}).transcribe({ recordingId: 'a' });
	const read = await folder.read();
	expect(read.data?.transcriptions.items).toEqual([]);
	return run;
}

test('a request refused before it left says nothing was sent', async () => {
	for (const { error } of [
		InferenceError.NotSent({ reason: 'the shell refused it' }),
		InferenceError.EndpointGone({ name: 'Provider' }),
		InferenceError.EndpointMoved({
			name: 'Provider',
			expected: target.address,
			now: 'https://elsewhere.test/v1',
		}),
	]) {
		const failed = expectErr(await runWith(error));
		expect(failed.name).toBe('NotSent');
		expect(failed.message).toBe(error.message);
		expect(failed.message).toMatch(/nothing was sent/i);
	}
});

test('a request that was made says why in its own words, never that nothing was sent', async () => {
	for (const { error } of [
		InferenceError.OutcomeUnknown({ name: 'Provider', reason: 'reset' }),
		InferenceError.Rejected({ name: 'Provider', status: 429, detail: 'busy' }),
		InferenceError.Failed({ name: 'Provider', detail: 'overloaded' }),
		InferenceError.Malformed({ name: 'Provider', reason: 'no text' }),
	]) {
		const failed = expectErr(await runWith(error));
		expect(failed.name).toBe('Failed');
		expect(failed.message).toBe(error.message);
		expect(failed.message).not.toMatch(
			/nothing was sent|no answer was received/i,
		);
	}
});
