/** The SHA-256 that names a file's exact bytes, on every storage backend. */
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
