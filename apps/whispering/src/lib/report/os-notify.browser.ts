import { createLogger } from 'wellcrafted/logger';
import { Ok, trySync } from 'wellcrafted/result';

const log = createLogger('whispering/browser-notification');

/** Background notices can use a grant already given through browser settings. */
export function osNotify(title: string, body: string | undefined): void {
	if (
		typeof Notification === 'undefined' ||
		Notification.permission !== 'granted'
	)
		return;
	trySync({
		try: () => {
			new Notification(title, { body });
		},
		catch: (cause) => {
			log.warn(
				new Error('Could not display a browser notification.', { cause }),
			);
			return Ok(undefined);
		},
	});
}
