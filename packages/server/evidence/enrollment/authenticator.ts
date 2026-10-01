import type {
	AuthenticationResponseJSON,
	RegistrationResponseJSON,
} from '@simplewebauthn/server';

/** Test-only authenticator: emits an ES256, none-attestation registration. */
export async function createAuthenticator(origin: string) {
	const key = await crypto.subtle.generateKey(
		{ name: 'ECDSA', namedCurve: 'P-256' },
		true,
		['sign', 'verify'],
	);
	const jwk = await crypto.subtle.exportKey('jwk', key.publicKey);
	if (!jwk.x || !jwk.y) throw new Error('Missing EC coordinates');
	const id = crypto.getRandomValues(new Uint8Array(32));
	const publicKey = join(
		new Uint8Array([0xa5, 1, 2, 3, 0x26, 0x20, 1, 0x21, 0x58, 32]),
		decode(jwk.x),
		new Uint8Array([0x22, 0x58, 32]),
		decode(jwk.y),
	);
	const rpHash = new Uint8Array(
		await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(new URL(origin).hostname),
		),
	);
	let counter = 0;
	return {
		async register(challenge: string): Promise<RegistrationResponseJSON> {
			const authData = join(
				rpHash,
				new Uint8Array([0x45, 0, 0, 0, 0]),
				new Uint8Array(16),
				new Uint8Array([0, id.length]),
				id,
				publicKey,
			);
			// CBOR {fmt: 'none', attStmt: {}, authData: bytes}.
			const attestation = join(
				new Uint8Array([0xa3, 0x63]),
				new TextEncoder().encode('fmt'),
				new Uint8Array([0x64]),
				new TextEncoder().encode('none'),
				new Uint8Array([0x67]),
				new TextEncoder().encode('attStmt'),
				new Uint8Array([0xa0, 0x68]),
				new TextEncoder().encode('authData'),
				new Uint8Array([0x58, authData.length]),
				authData,
			);
			return {
				id: encode(id),
				rawId: encode(id),
				type: 'public-key',
				clientExtensionResults: {},
				response: {
					clientDataJSON: encode(
						new TextEncoder().encode(
							JSON.stringify({
								type: 'webauthn.create',
								challenge,
								origin,
								crossOrigin: false,
							}),
						),
					),
					attestationObject: encode(attestation),
					transports: ['internal'],
				},
			};
		},
		async authenticate(challenge: string): Promise<AuthenticationResponseJSON> {
			const count = new Uint8Array(4);
			new DataView(count.buffer).setUint32(0, ++counter);
			const authData = join(rpHash, new Uint8Array([5]), count);
			const clientData = new TextEncoder().encode(
				JSON.stringify({
					type: 'webauthn.get',
					challenge,
					origin,
					crossOrigin: false,
				}),
			);
			const clientHash = new Uint8Array(
				await crypto.subtle.digest('SHA-256', clientData),
			);
			const signature = new Uint8Array(
				await crypto.subtle.sign(
					{ name: 'ECDSA', hash: 'SHA-256' },
					key.privateKey,
					join(authData, clientHash),
				),
			);
			// WebCrypto returns P1363; WebAuthn ES256 uses ASN.1 DER integers.
			function integer(bytes: Uint8Array) {
				let start = 0;
				while (start < bytes.length - 1 && bytes[start] === 0) start++;
				const value = bytes.slice(start);
				const positive =
					(value[0] ?? 0) >= 128 ? join(new Uint8Array([0]), value) : value;
				return join(new Uint8Array([2, positive.length]), positive);
			}
			const pair = join(
				integer(signature.slice(0, 32)),
				integer(signature.slice(32)),
			);
			return {
				id: encode(id),
				rawId: encode(id),
				type: 'public-key',
				clientExtensionResults: {},
				response: {
					clientDataJSON: encode(clientData),
					authenticatorData: encode(authData),
					signature: encode(join(new Uint8Array([0x30, pair.length]), pair)),
				},
			};
		},
	};
}
function join(...parts: Uint8Array[]) {
	const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}
function encode(bytes: Uint8Array) {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');
}
function decode(value: string) {
	return Uint8Array.from(
		atob(value.replaceAll('-', '+').replaceAll('_', '/')),
		(char) => char.charCodeAt(0),
	);
}

export async function registration(challenge: string, origin: string) {
	return (await createAuthenticator(origin)).register(challenge);
}
