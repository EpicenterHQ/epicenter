let opening: Promise<typeof import('./bootstrap.js')> | undefined;
let application: typeof import('./bootstrap.js') | undefined;
let ready:
	| Awaited<NonNullable<typeof import('./bootstrap.js')['opening']>>
	| undefined;

/** Importing this module acquires nothing. The mounted page opens once. */
export function openApplication() {
	opening ??= import('./bootstrap.js').then((opened) => {
		application = opened;
		void opened.opening?.then(
			(app) => {
				ready = app;
			},
			() => {},
		);
		return opened;
	});
	return opening;
}

/** Read the document's concrete App only after readiness and before App closure. Admitted work can finish during UI drain. */
export function getApp() {
	if (!ready || !application || ready.app.signal.aborted) {
		throw new Error('Whispering is not ready or is closing.');
	}
	return ready.app;
}

/** Read workflow choices from the same ready document as product operations. */
export function getSelections() {
	getApp();
	if (!application?.selections)
		throw new Error('Whispering selections are unavailable.');
	return application.selections;
}
