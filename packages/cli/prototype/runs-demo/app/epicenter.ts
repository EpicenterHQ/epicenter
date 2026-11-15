/** PROTOTYPE: A receipt and delayed text make host-owned file runs observable. */
import { callSignal, defineAction, defineApp, field } from '@epicenter/app';

function sleep(ms: number) {
	const signal = callSignal();
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const stop = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', stop);
			resolve();
		}, ms);
		signal.addEventListener('abort', stop, { once: true });
	});
}

export default defineApp({
	description: 'PROTOTYPE: Host-owned runs with file inputs',
	collections: {},
	actions: {
		transcribe: defineAction({
			description: 'Read a file and stream delayed text',
			input: {
				audio: field.file({
					accept: ['audio/*', 'text/plain', 'application/octet-stream'],
				}),
				chunks: field.integer({ optional: true, min: 1, max: 200 }),
				delayMs: field.integer({ optional: true, min: 0, max: 5000 }),
			},
			annotations: { readOnlyHint: true },
			async *run({ audio, chunks = 4, delayMs = 250 }) {
				const bytes = await audio.bytes();
				const sha256 = new Bun.CryptoHasher('sha256')
					.update(bytes)
					.digest('hex');
				yield {
					kind: 'received' as const,
					name: audio.name,
					type: audio.type,
					size: audio.size,
					sha256,
				};
				const text =
					audio.type.split(';')[0]?.trim().toLowerCase() === 'text/plain'
						? (await audio.text()).trim().split(/\s+/).filter(Boolean)
						: Array.from(
								{ length: chunks },
								(_, index) => `chunk ${index + 1} of ${chunks}`,
							);
				for (const [index, chunk] of text.entries()) {
					await sleep(delayMs);
					yield { kind: 'text' as const, index, chunk };
				}
				return { text: text.join(' '), size: bytes.byteLength, sha256 };
			},
		}),
	},
});
