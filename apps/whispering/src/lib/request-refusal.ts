/**
 * Failures that stop a request before anything is sent, by the name each
 * carries: an endpoint's or the desktop shell's refusal of a request that
 * does not read (`InvalidRequest`), the shell's refusals of where it would
 * go or of a key it cannot read (`ConnectionFetchError`), an account with
 * no token to send (`AccountUnavailable`), and hosted inference while signed
 * out (`SignedOut`). Any other failure of a request that was handed over may
 * have reached the endpoint.
 */
const BEFORE_SEND = new Set([
	'InvalidRequest',
	'SchemeRefused',
	'OriginRefused',
	'CredentialsFailed',
	'AccountUnavailable',
	'SignedOut',
]);

/**
 * Why nothing was sent, when `cause` is one of these refusals: an `Error`
 * or a tagged error object, by its `name`. Undefined for any other failure.
 */
export function refusedBeforeSend(cause: unknown): string | undefined {
	if (typeof cause !== 'object' || cause === null) return undefined;
	const { name, message } = cause as { name?: unknown; message?: unknown };
	if (typeof name !== 'string' || !BEFORE_SEND.has(name)) return undefined;
	return typeof message === 'string' ? message : name;
}
