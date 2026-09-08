import { createMailApp } from '@epicenter/local-mail/accounts';
import { openLocalMailStorage } from '@epicenter/local-mail/storage';
import { device } from '#platform/device';
import { gmailAuthorization } from '#platform/gmail-authorization';
import { createMail } from './create-mail.js';
import { gmailIdentity } from './identity.js';

/** One operation owner per document, bound to this build's storage and consent UI. */
export const mail = createMail({
	openApp: async () =>
		createMailApp({
			device,
			storage: await openLocalMailStorage(device),
			identity: gmailIdentity(),
		}),
	authorization: gmailAuthorization,
});
