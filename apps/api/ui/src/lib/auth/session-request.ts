/** Parse the initiating app's public binding. The server owns callback approval. */
export function readSessionRequest(search: string) {
	const params = new URLSearchParams(search);
	if (
		!['callback', 'challenge', 'state'].every(
			(key) => params.getAll(key).length === 1,
		)
	)
		return null;
	const callback = params.get('callback') ?? '';
	const challenge = params.get('challenge') ?? '';
	const state = params.get('state') ?? '';
	if (!/^[a-z][a-z\d+.-]*:\/\//i.test(callback) || /[\s\\#?]/.test(callback))
		return null;
	if (
		!/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
		!/^[A-Za-z0-9_-]{32,128}$/.test(state)
	)
		return null;
	try {
		const url = new URL(callback);
		if (!url.host || url.username || url.password || url.href !== callback)
			return null;
	} catch {
		return null;
	}
	return {
		callback,
		challenge,
		state,
		reauthenticate: params.get('reauth') === '1',
	};
}
