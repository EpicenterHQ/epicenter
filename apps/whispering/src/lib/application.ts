import { createLogger } from 'wellcrafted/logger';

const log = createLogger('whispering/application');

let opening: Promise<typeof import('./bootstrap.js')> | undefined;
let application: typeof import('./bootstrap.js') | undefined;
let ready = false;

/** Importing this module acquires nothing. The mounted page opens once. */
export function openApplication() {
	opening ??= import('./bootstrap.js').then((opened) => {
		application = opened;
		void opened.app?.ready
			.then(async (result) => {
				if (result.error) return;
				ready = true;
			})
			.catch((cause) => {
				log.error(
					new Error('Whispering failed to release an unsuccessful opening.', {
						cause,
					}),
				);
			});
		return opened;
	});
	return opening;
}

/** Read the document's concrete App only after readiness and before App closure. Admitted work can finish during UI drain. */
export function getApp() {
	if (!ready || !application?.app || application.isClosing()) {
		throw new Error('Whispering is not ready or is closing.');
	}
	return application.app;
}
