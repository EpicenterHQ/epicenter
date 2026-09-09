/**
 * Mail page closure waits for admitted work and permanently refuses new work.
 * A pending open or consent operation cannot escape the desktop close barrier,
 * including when that operation fails while the page is closing.
 */
import { expect, test } from 'bun:test';
import { createMailApp, type MailApp } from '@epicenter/local-mail/accounts';
import { createMail } from './create-mail.js';

const request = {
	authorizeUrl: 'https://accounts.google.com/',
	state: 'state',
	codeVerifier: 'verifier',
	redirectUri: 'http://localhost/connected',
};

test('close waits for an admitted open to settle and refuses later operations', async () => {
	const opening = Promise.withResolvers<MailApp>();
	const releasing = Promise.withResolvers<void>();
	const releaseEntered = Promise.withResolvers<void>();
	let opens = 0;
	const mail = createMail({
		closeStorage: async () => {
			releaseEntered.resolve();
			await releasing.promise;
		},
		openApp: () => {
			opens++;
			return opening.promise;
		},
		authorization: {
			authorize: async () => new URL('http://localhost/connected'),
		},
	});
	const accounts = mail.accounts();
	const failedAccounts = accounts.catch((error: unknown) => error);
	let closed = false;
	const closing = mail.close();
	void closing.then(() => {
		closed = true;
	});
	await Promise.resolve();
	expect(opens).toBe(1);
	expect(closed).toBe(false);
	await expect(mail.accounts()).rejects.toThrow('Local Mail is closing.');
	expect(opens).toBe(1);
	opening.reject(new Error('open failed'));
	expect(await failedAccounts).toEqual(new Error('open failed'));
	await releaseEntered.promise;
	expect(closed).toBe(false);
	releasing.resolve();
	await closing;
	expect(closed).toBe(true);
	expect(mail.close()).toBe(closing);
});

test('close aborts consent but waits for the authorization owner to finish', async () => {
	const consent = Promise.withResolvers<URL>();
	const entered = Promise.withResolvers<AbortSignal>();
	const mail = createMail({
		closeStorage: async () => {},
		openApp: async () => {
			throw new Error('must not open');
		},
		authorization: {
			authorize: (_request, signal) => {
				entered.resolve(signal);
				return consent.promise;
			},
		},
	});
	const authorizing = mail.authorize(request);
	const failure = authorizing.catch((error: unknown) => error);
	const signal = await entered.promise;
	let closed = false;
	const closing = mail.close();
	void closing.then(() => {
		closed = true;
	});
	await Promise.resolve();
	expect(signal.aborted).toBe(true);
	expect(closed).toBe(false);
	consent.reject(new Error('consent stopped'));
	expect(await failure).toEqual(new Error('consent stopped'));
	await closing;
	expect(closed).toBe(true);
});

test('close waits for an admitted durable write before acknowledging closure', async () => {
	const committed = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const unused = async (): Promise<never> => {
		throw new Error('unexpected storage operation');
	};
	const app = createMailApp({
		identity: { clientId: 'test', clientSecret: 'test' },
		device: {
			close: async () => {},
			sqlite: { open: unused, delete: unused },
			secrets: { get: unused, put: unused, delete: unused },
		},
		storage: {
			local: {
				run: unused,
				all: unused,
				batch: async () => {
					entered.resolve();
					await committed.promise;
					return { data: { changes: [3] }, error: null };
				},
			},
			mail: unused,
			forgetMail: unused,
		},
	});
	const mail = createMail({
		closeStorage: async () => {},
		openApp: async () => app,
		authorization: { authorize: unused },
	});
	const discarded = mail.discard('account');
	await entered.promise;
	let closed = false;
	const closing = mail.close();
	void closing.then(() => {
		closed = true;
	});
	await Promise.resolve();
	expect(closed).toBe(false);
	committed.resolve();
	expect(await discarded).toBe(3);
	await closing;
	expect(closed).toBe(true);
});
