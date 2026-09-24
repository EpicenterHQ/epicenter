/**
 * App admission tests. The existing local key excludes older windows and scopes
 * ownership by app and captured identity. Refused opens never release an owner.
 */
import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/principal';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { claimApp } from './app-claim.js';
import { installTestLocks } from './test-locks.js';

installTestLocks();

test('App admission separates app and account namespaces and refuses duplicates', async () => {
	const account = { authorityId: 'cloud', principalId: asPrincipalId('alice') };
	const appId = 'so.epicenter.admission';
	const first = expectOk(await claimApp(appId, account));
	const independent = [
		expectOk(await claimApp(appId)),
		expectOk(await claimApp('so.epicenter.other', account)),
		expectOk(
			await claimApp(appId, { ...account, principalId: asPrincipalId('bob') }),
		),
	];
	expect(expectErr(await claimApp(appId, account)).name).toBe('AlreadyOpen');
	for (const claim of independent) claim.release();
	expect(expectErr(await claimApp(appId, account)).name).toBe('AlreadyOpen');
	first.release();
	expectOk(await claimApp(appId, account)).release();
});

test('admission preserves canonical local key bytes and excludes account capabilities', async () => {
	const account = {
		principalId: asPrincipalId('alice'),
		authorityId: 'cloud',
		token: 'private',
	};
	const first = expectOk(await claimApp('so.epicenter.bytes', account));
	try {
		expect(
			expectErr(await claimApp('so.epicenter.bytes', account)).address,
		).toBe(
			'library:["so.epicenter.bytes","device","accounts/636c6f7564/616c696365"]',
		);
	} finally {
		first.release();
	}
});

test('missing locks and failed requests return distinct claim failures', async () => {
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			'--eval',
			`
   const { claimApp } = await import(${JSON.stringify(new URL('./app-claim.ts', import.meta.url).href)});
   Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});
   const results=[await claimApp('so.epicenter.errors')];
   navigator.locks={request(){throw new Error('thrown')}};
   results.push(await claimApp('so.epicenter.errors'));
   navigator.locks={request(){return Promise.reject(new Error('rejected'))}};
   results.push(await claimApp('so.epicenter.errors'));
   console.log(JSON.stringify(results.map(({error})=>error.name)));
  `,
		],
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ stderr, code }).toEqual({ stderr: '', code: 0 });
	expect(JSON.parse(stdout)).toEqual([
		'LocksUnsupported',
		'ClaimFailed',
		'ClaimFailed',
	]);
});
