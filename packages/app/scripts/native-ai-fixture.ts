/** Actual native inference behind a test-only stdin bridge and Tauri MockRuntime. */
import assert from 'node:assert/strict';
import { createNativeTransport } from '../src/native-ai.js';

export async function createNativeAiFixture({
	audioPath,
	timeoutMs = 120_000,
}: {
	audioPath: string;
	timeoutMs?: number;
}) {
	assert(
		await Bun.file(audioPath).exists(),
		'Speech fixture must already exist',
	);
	const child = Bun.spawn(
		[
			'cargo',
			'test',
			'--manifest-path',
			'apps/epicenter/src-tauri/Cargo.toml',
			'--test',
			'ai_runtime',
			'sdk_native_command_bridge',
			'--',
			'--ignored',
			'--nocapture',
		],
		{
			cwd: new URL('../../../', import.meta.url).pathname,
			env: { ...process.env, EPICENTER_NATIVE_AUDIO: audioPath },
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'inherit',
		},
	);
	const timeout = setTimeout(() => child.kill(), timeoutMs);
	const ready = Promise.withResolvers<void>();
	const pending = new Map<
		number,
		ReturnType<typeof Promise.withResolvers<unknown>>
	>();
	const admitted: Record<string, unknown>[] = [];
	const completed: Record<string, unknown>[] = [];
	let nextId = 0;
	let settingsUnchanged = false;
	let admission: ReturnType<typeof Promise.withResolvers<number>> | undefined;
	let closing: Promise<{ settingsUnchanged: true }> | undefined;

	const output = (async () => {
		let buffer = '';
		const decoder = new TextDecoder();
		const reader = child.stdout.getReader();
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			buffer += decoder.decode(chunk.value, { stream: true });
			for (;;) {
				const newline = buffer.indexOf('\n');
				if (newline === -1) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line.startsWith('EPICENTER_AI ')) continue;
				const message = JSON.parse(line.slice('EPICENTER_AI '.length));
				switch (message.event) {
					case 'ready':
						ready.resolve();
						break;
					case 'admitted':
						admitted.push(message);
						admission?.resolve(message.id);
						admission = undefined;
						break;
					case 'completed': {
						completed.push(message);
						const request = pending.get(message.id);
						assert(request, 'Native response names an admitted request');
						pending.delete(message.id);
						if ('error' in message)
							request.reject(new Error(JSON.stringify(message.error)));
						else request.resolve(message.value);
						break;
					}
					case 'finished':
						settingsUnchanged = message.settingsUnchanged === true;
						break;
					default:
						throw new Error(`Unknown native bridge event: ${message.event}`);
				}
			}
		}
	})();
	function fail(error: unknown) {
		ready.reject(error);
		admission?.reject(error);
		for (const request of pending.values()) request.reject(error);
	}
	void output.catch((error) => {
		fail(error);
		child.kill();
	});
	void child.exited.then((code) => {
		clearTimeout(timeout);
		fail(
			new Error(
				`Native bridge exited (${code}) before completing the request.`,
			),
		);
	});
	try {
		await ready.promise;
	} catch (error) {
		clearTimeout(timeout);
		if (child.exitCode === null) child.kill();
		await child.exited;
		throw error;
	}

	return {
		transport: createNativeTransport((command, args = {}) => {
			if (closing) throw new Error('Native test fixture is closed.');
			if (child.exitCode !== null)
				throw new Error('Native test fixture exited.');
			const id = ++nextId;
			const response = Promise.withResolvers<unknown>();
			pending.set(id, response);
			try {
				child.stdin.write(`${JSON.stringify({ id, command, args })}\n`);
			} catch (error) {
				pending.delete(id);
				response.reject(error);
			}
			return response.promise;
		}),
		admitted,
		completed,
		nextAdmission() {
			assert(
				!admission,
				'Only one native admission observation can be pending',
			);
			admission = Promise.withResolvers<number>();
			return admission.promise;
		},
		close() {
			closing ??= (async () => {
				await Promise.allSettled(
					[...pending.values()].map((request) => request.promise),
				);
				await child.stdin.end();
				assert.equal(await child.exited, 0, 'Native bridge exited cleanly');
				await output;
				assert(
					settingsUnchanged,
					'Temporary native settings remained unchanged',
				);
				return { settingsUnchanged: true as const };
			})();
			return closing;
		},
	};
}
