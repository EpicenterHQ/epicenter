/** Shell and CLI failures that happen before an inference request is sent. */
const BEFORE_SEND = new Set([
	'Refused',
	'InvalidRequest',
	'NoKey',
	'EndpointChanged',
	'NoAccessToken',
	'NoAccountToken',
	'AccountUnavailable',
	'GrantChanged',
	'KeychainUnavailable',
	'EntryUnreadable',
	'LocalNotSent',
]);

export function refusedBeforeSend(cause: unknown): cause is Error {
	return cause instanceof Error && BEFORE_SEND.has(cause.name);
}
