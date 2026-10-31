/** A file's bytes as storage holds them: text, or binary. */
export type FileContent = string | Uint8Array;

const encoder = new TextEncoder();

/** Byte equality across text and binary representations; null means absent. */
export function sameContent(
	left: FileContent | null,
	right: FileContent | null,
) {
	if (left === null || right === null) return left === right;
	if (typeof left === 'string' && typeof right === 'string')
		return left === right;
	const a = typeof left === 'string' ? encoder.encode(left) : left;
	const b = typeof right === 'string' ? encoder.encode(right) : right;
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
