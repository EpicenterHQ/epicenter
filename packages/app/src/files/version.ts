/**
 * Content identity for captured file bytes.
 *
 * A version is computed from the exact bytes an operation observed or intends
 * to publish. It is not a timestamp, generation counter, or storage key, so a
 * browser and a native folder assign the same version to the same bytes.
 */

/** SHA-256 plus byte length of one captured file. */
export type FileVersion = {
	readonly sha256: string;
	readonly size: number;
};

/**
 * The condition a managed write checks at its publication point.
 *
 * - A `FileVersion` requires the current bytes to be exactly those bytes.
 * - `'absent'` requires no file at the path (exclusive creation).
 * - `'any'` is a deliberate overwrite, such as a shell redirection.
 */
export type FileExpectation = FileVersion | 'absent' | 'any';

const encoder = new TextEncoder();

/** Hash bytes before any storage transaction starts; a transaction cannot await crypto. */
export async function captureVersion(bytes: Uint8Array): Promise<FileVersion> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		bytes as Uint8Array<ArrayBuffer>,
	);
	return Object.freeze({ sha256: toHex(digest), size: bytes.byteLength });
}

export function sameVersion(
	left: FileVersion | undefined,
	right: FileVersion | undefined,
): boolean {
	if (left === undefined || right === undefined) return left === right;
	return left.sha256 === right.sha256 && left.size === right.size;
}

/** Whether `current` (undefined when absent) satisfies `expected`. */
export function satisfies(
	current: FileVersion | undefined,
	expected: FileExpectation,
): boolean {
	if (expected === 'any') return true;
	if (expected === 'absent') return current === undefined;
	return sameVersion(current, expected);
}

export function encodeText(text: string): Uint8Array {
	return encoder.encode(text);
}

function toHex(buffer: ArrayBuffer): string {
	let hex = '';
	for (const byte of new Uint8Array(buffer))
		hex += byte.toString(16).padStart(2, '0');
	return hex;
}
