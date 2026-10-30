import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { ApprovalPolicy, Sandbox } from '../src/lib/api-types.js';

export function loadConfig(
	env: Record<string, string | undefined> = process.env,
) {
	const port = Number(env.PORT ?? 5190);
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error('PORT must be an integer from 1 to 65535');
	const token =
		env.CODEX_VOICE_QUEUE_TOKEN ?? randomBytes(32).toString('base64url');
	if (token.length < 32)
		throw new Error(
			'CODEX_VOICE_QUEUE_TOKEN must contain at least 32 characters',
		);
	const sandbox = env.CODEX_VOICE_QUEUE_SANDBOX ?? 'workspace-write';
	if (sandbox !== 'workspace-write' && sandbox !== 'read-only')
		throw new Error(
			'CODEX_VOICE_QUEUE_SANDBOX must be workspace-write or read-only',
		);
	const approval = env.CODEX_VOICE_QUEUE_APPROVAL ?? 'on-request';
	if (approval !== 'on-request' && approval !== 'untrusted')
		throw new Error(
			'CODEX_VOICE_QUEUE_APPROVAL must be on-request or untrusted',
		);
	const models = [
		'ggml-large-v3-turbo.bin',
		'ggml-small.bin',
		'ggml-tiny.bin',
	].map((name) =>
		resolve(
			homedir(),
			'Library/Application Support/com.bradenwong.whispering/models/whisper',
			name,
		),
	);
	const allowedOrigins = (env.CODEX_VOICE_QUEUE_ALLOWED_ORIGINS ?? '')
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean);
	for (const origin of allowedOrigins) {
		const url = new URL(origin);
		if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin)
			throw new Error(`Invalid allowed origin: ${origin}`);
	}
	return {
		port,
		token,
		hostname: '127.0.0.1' as const,
		codexBin: env.CODEX_BIN ?? 'codex',
		sandbox: sandbox as Sandbox,
		approval: approval as ApprovalPolicy,
		whisperCli: env.WHISPER_CLI ?? Bun.which('whisper-cli'),
		ffmpeg: env.FFMPEG ?? Bun.which('ffmpeg'),
		model: env.WHISPER_MODEL ?? models.find(existsSync) ?? null,
		language: env.WHISPER_LANGUAGE ?? 'en',
		allowedOrigins,
		staticDir: resolve(env.STATIC_DIR ?? resolve(import.meta.dir, '../build')),
	};
}
export type Config = ReturnType<typeof loadConfig>;
