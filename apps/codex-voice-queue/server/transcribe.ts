import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptionProbe } from '../src/lib/api-types.js';
import { ValidationError } from './codex-service.js';
import type { Config } from './config.js';

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export function normalizeTranscription(text: string) {
	return text
		.replace(/\[(?:BLANK_AUDIO|MUSIC|SILENCE)\]|\((?:silence|music)\)/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}
async function run(command: string[]) {
	const child = Bun.spawn(command, {
		stdin: 'ignore',
		stdout: 'ignore',
		stderr: 'pipe',
	});
	let tail = '';
	const drain = (async () => {
		for await (const chunk of child.stderr.pipeThrough(new TextDecoderStream()))
			tail = (tail + chunk).slice(-6000);
	})();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill('SIGKILL');
	}, 120_000);
	try {
		const code = await child.exited;
		await drain;
		if (timedOut)
			throw new Error(
				`Transcription process timed out after 120 seconds: ${tail}`,
			);
		if (code !== 0)
			throw new Error(`Transcription process exited ${code}: ${tail}`);
	} finally {
		clearTimeout(timer);
	}
}
export function createTranscriber({
	config,
}: {
	config: Pick<Config, 'whisperCli' | 'ffmpeg' | 'model' | 'language'>;
}) {
	let queue: Promise<unknown> = Promise.resolve();
	function probe(): TranscriptionProbe {
		let reason: string | null = null;
		if (!config.whisperCli || !existsSync(config.whisperCli))
			reason =
				'whisper-cli is unavailable. Set WHISPER_CLI to its executable path.';
		else if (!config.ffmpeg || !existsSync(config.ffmpeg))
			reason = 'ffmpeg is unavailable. Set FFMPEG to its executable path.';
		else if (!config.model || !existsSync(config.model))
			reason =
				'Whisper model is unavailable. Set WHISPER_MODEL to a local model file.';
		return { available: reason === null, reason, model: config.model };
	}
	return {
		probe,
		transcribe(bytes: Uint8Array, mimeType: string) {
			if (bytes.byteLength > MAX_AUDIO_BYTES)
				return Promise.reject(new ValidationError('Audio exceeds 25 MB', 413));
			const job = queue.then(async () => {
				const availability = probe();
				if (
					!availability.available ||
					!config.model ||
					!config.ffmpeg ||
					!config.whisperCli
				)
					throw new ValidationError(
						availability.reason ?? 'Transcription unavailable',
						503,
					);
				const startedAt = Date.now();
				const dir = await mkdtemp(join(tmpdir(), 'codex-voice-queue-'));
				try {
					const kind = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
					const extension =
						(
							{
								'audio/webm': 'webm',
								'audio/ogg': 'ogg',
								'audio/mp4': 'mp4',
								'audio/wav': 'wav',
								'audio/x-wav': 'wav',
								'audio/m4a': 'm4a',
								'audio/x-m4a': 'm4a',
							} as Record<string, string>
						)[kind] ?? 'bin';
					const input = join(dir, `input.${extension}`);
					const wav = join(dir, 'audio.wav');
					await Bun.write(input, bytes);
					await run([
						config.ffmpeg,
						'-nostdin',
						'-y',
						'-i',
						input,
						'-ar',
						'16000',
						'-ac',
						'1',
						'-c:a',
						'pcm_s16le',
						wav,
					]);
					await run([
						config.whisperCli,
						'-m',
						config.model,
						'-f',
						wav,
						'-l',
						config.language,
						'-nt',
						'-np',
						'-otxt',
						'-of',
						join(dir, 'out'),
					]);
					return {
						text: normalizeTranscription(
							await Bun.file(join(dir, 'out.txt')).text(),
						),
						durationMs: Date.now() - startedAt,
						model: config.model,
					};
				} finally {
					await rm(dir, { recursive: true, force: true });
				}
			});
			queue = job.catch(() => undefined);
			return job;
		},
	};
}
export type Transcriber = ReturnType<typeof createTranscriber>;
