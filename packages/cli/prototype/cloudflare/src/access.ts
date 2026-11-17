// Identity is verified by the API before it calls the private HomeGateway.
export async function homeKey(authority: string, principal: string) {
	const bytes = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(JSON.stringify([authority, principal])),
	);
	return [...new Uint8Array(bytes)]
		.map((n) => n.toString(16).padStart(2, '0'))
		.join('');
}
export function runAddress(path: string) {
	const match =
		/^(?:\/tasks~[-a-zA-Z0-9]+)?\/\.runs\/tasks\/([a-zA-Z0-9.-]+)\/([-a-zA-Z0-9]{1,80})(?:\/(events|cancel))?$/.exec(
			path,
		);
	return match
		? { action: match[1], id: match[2], operation: match[3] }
		: undefined;
}
