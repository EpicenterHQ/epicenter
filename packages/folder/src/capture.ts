/** Captures identify the exact bytes observed or submitted, across every storage backend. */

import { Ok, type Result } from 'wellcrafted/result';
import { FileError } from './errors.js';

/** A fixed path and SHA-256 of the bytes captured there. Holds no lease. */
export type FileCapture = {
	path: string;
	sha256: string;
};

/** A capture with detached bytes. */
export type CapturedFile = FileCapture & { bytes: Uint8Array };

/** A capture with the exact text decoded from its whole bytes. */
export type TextCapture = FileCapture & { text: string };

/**
 * A capture that carries the content it names: the base a save merges from
 * (ADR-0551). Every capture the engine returns from a read or a save is one.
 */
export type ContentCapture = CapturedFile | TextCapture;

/** Detach a capture from its caller. Later saves return new captures. */
export function fileCapture(path: string, sha256: string): FileCapture {
	return Object.freeze({ path, sha256 });
}

/** Validate and detach a caller's capture before any asynchronous work. */
export function ownCapture(
	file: FileCapture,
): Result<FileCapture, Extract<FileError, { name: 'InvalidPath' }>> {
	const path = (file as Partial<FileCapture> | null | undefined)?.path;
	if (typeof path !== 'string')
		return FileError.InvalidPath({
			path: String(path ?? ''),
			reason: 'the capture has no path',
		});
	const sha256 = (file as Partial<FileCapture> | null | undefined)?.sha256;
	if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256))
		return FileError.InvalidPath({
			path,
			reason: 'the capture has no valid SHA-256',
		});
	return Ok(fileCapture(path, sha256));
}

const encoder = new TextEncoder();
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Encode text for a save. Encoding replaces an unpaired surrogate, so the
 * saved text is decoded from the bytes, with the decoder that reads files,
 * and never assumed to be the string that was typed. A byte order mark,
 * CRLF, and paired surrogates come back as they went in.
 */
export function submittedText(text: string) {
	const bytes = encoder.encode(text);
	return { bytes, text: utf8.decode(bytes) };
}

/** Own content before awaiting anything. Strings encode as UTF-8 without normalization. */
export function ownBytes(content: string | Uint8Array): Uint8Array {
	return typeof content === 'string'
		? encoder.encode(content)
		: new Uint8Array(content);
}

/** Hash before starting storage transactions, which cannot await crypto. */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		bytes as Uint8Array<ArrayBuffer>,
	);
	let hex = '';
	for (const byte of new Uint8Array(digest))
		hex += byte.toString(16).padStart(2, '0');
	return hex;
}
