/**
 * Billing policy + service tests.
 *
 * These exercise the REAL billing service and the REAL policies. Nothing is
 * module-mocked; instead we `spyOn` the real `autumn-js` client's methods
 * (`check` / `track` on `Autumn.prototype`, and `finalize` / `getOrCreate` on the
 * shared `balances` / `customers` sub-client prototypes), each controllable per
 * test. Running the real service is deliberate: it is the only way to pin
 * `trackAiTranscription`'s `track({ async: true })` shape and per-minute credit
 * math, which a service stub would hide.
 *
 * (Why spies, not a module mock: bun's `mock.module` is a process-global,
 * hoisted, non-restorable override. Mocking `./service.js` would make the real
 * service unreachable in every file of the run; mocking `./autumn.js` or
 * `autumn-js` would break `autumn.test.ts`, which needs their real exports and
 * error classes. Spying on the real client sidesteps both, so `tryAutumn` and
 * the provider-error mapping run for real here too.)
 *
 * What they pin:
 *   - AI chat reservation: confirm on a 200, release on a >= 400, and a guard
 *     rejection answers in the OpenAI error shape while reserving nothing.
 *   - STT metering: a usable-wallet gate before the call, then a per-minute
 *     `track({ async: true })` settled off the after-response queue on a 200;
 *     nothing tracked on a denial, a non-200, or a provider outage.
 *   - The service settles STT as an async usage event (202, no balance body) and
 *     swallows a post-success metering failure into a `Result`, never a throw.
 */

import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type { PrincipalId } from '@epicenter/principal';
import type { CloudEnv } from '@epicenter/server';
import { Autumn, ConnectionError } from 'autumn-js';
import { Hono } from 'hono';
import { FEATURE_IDS, PLAN_IDS, PLANS } from './catalog.js';
import {
	chargeOpenAiCreditsWithAutumn,
	chargeOpenAiTranscriptionCredits,
} from './policies.js';
import { createBillingService } from './service.js';

// ----- Real service + real policies against a spied Autumn client ------------
//
// No module is mocked: `autumn.test.ts` needs the real `./autumn.js` and the
// real `autumn-js` error classes, so instead of swapping a module we spy on the
// real client's methods. The service constructs its own client internally; these
// spies (top-level `check` / `track` on `Autumn.prototype`, plus the shared
// nested `balances` / `customers` sub-client prototypes) intercept every
// instance, and are restored after each test.

type CheckInput = { featureId: string; requiredBalance?: number };
type TrackArgs = {
	customerId: string;
	featureId: string;
	value: number;
	async?: boolean;
	properties?: Record<string, unknown>;
};

/** A customer with no subscription resolves to the free plan in the service. */
let customerState: {
	subscriptions: Array<{ addOn?: boolean; planId?: string }>;
} = { subscriptions: [] };
/** Drives every `autumn.check` (chat reserve lock + STT gate). May throw. */
let checkImpl: (input: CheckInput) => { allowed: boolean; balance: unknown } =
	() => ({ allowed: true, balance: 100 });
/** Drives the post-success `autumn.track`. May throw (provider failure). */
let trackImpl: (args: TrackArgs) => Promise<unknown> = async () => ({
	id: 'evt_async',
});
const finalizeCalls: Array<'confirm' | 'release'> = [];
const trackCalls: TrackArgs[] = [];
const customerCalls: unknown[] = [];

// The nested sub-clients share one prototype across instances; a sample client
// hands us the objects to spy on. Cast to the narrow method shapes the service
// actually calls, so `spyOn` stays typed without touching `autumn-js` internals.
const clientProto = Autumn.prototype as unknown as {
	check: (input: CheckInput) => Promise<unknown>;
	track: (input: TrackArgs) => Promise<unknown>;
};
const sampleClient = new Autumn({ secretKey: 'sk_probe' }) as unknown as {
	balances: object;
	customers: object;
};
const balancesProto = Object.getPrototypeOf(sampleClient.balances) as {
	finalize: (input: { action: 'confirm' | 'release' }) => Promise<unknown>;
};
const customersProto = Object.getPrototypeOf(sampleClient.customers) as {
	getOrCreate: (...args: unknown[]) => Promise<unknown>;
};

beforeEach(() => {
	customerState = { subscriptions: [] };
	checkImpl = () => ({ allowed: true, balance: 100 });
	trackImpl = async () => ({ id: 'evt_async' });
	finalizeCalls.length = 0;
	trackCalls.length = 0;
	customerCalls.length = 0;

	spyOn(clientProto, 'check').mockImplementation(async (input) =>
		checkImpl(input),
	);
	spyOn(clientProto, 'track').mockImplementation(async (input) => {
		trackCalls.push(input);
		return trackImpl(input);
	});
	spyOn(balancesProto, 'finalize').mockImplementation(async ({ action }) => {
		finalizeCalls.push(action);
	});
	spyOn(customersProto, 'getOrCreate').mockImplementation(async (...args) => {
		customerCalls.push(args[0]);
		return customerState;
	});
});

afterEach(() => {
	mock.restore();
});

function withContext(app: Hono<CloudEnv>) {
	app.use('*', async (c, next) => {
		c.set('afterResponseQueue', []);
		c.set('principal', {
			id: 'user_1',
			email: 'user@example.com',
		} as CloudEnv['Variables']['principal']);
		await next();
	});
	return app;
}

function makeService() {
	return createBillingService(
		{ AUTUMN_SECRET_KEY: 'sk_test' },
		{
			principalId: 'user_1' as PrincipalId,
			principalEmail: 'user@example.com',
		},
	);
}

test('top-up checkout requests the catalog credit quantity from Autumn', async () => {
	const billing = new Autumn({ secretKey: 'sk_probe' }).billing;
	const attach = spyOn(
		Object.getPrototypeOf(billing) as typeof billing,
		'attach',
	).mockResolvedValue({
		customerId: 'user_1',
		paymentUrl: 'https://checkout.stripe.com/test',
	});
	const successUrl = 'http://localhost:5178/dashboard';
	const result = await makeService().checkoutTopUp({ successUrl });
	expect(attach).toHaveBeenCalledWith({
		customerId: 'user_1',
		planId: PLAN_IDS.creditTopUp,
		featureQuantities: [
			{
				featureId: FEATURE_IDS.aiCredits,
				quantity: PLANS[PLAN_IDS.creditTopUp].creditsPerPurchase,
			},
		],
		successUrl,
	});
	expect(result.checkoutUrl).toBe('https://checkout.stripe.com/test');
});

test('storage allowance defaults to Free and preserves billing identity', async () => {
	const includedBytes = await makeService().getStorageIncludedBytes();

	expect(includedBytes).toBe(PLANS[PLAN_IDS.free].storage.includedBytes);
	expect(customerCalls).toEqual([
		{
			customerId: 'user_1',
			email: 'user@example.com',
			expand: ['subscriptions.plan', 'balances.feature'],
		},
	]);
});

test('storage allowance selects the paid main subscription, not an add-on', async () => {
	customerState = {
		subscriptions: [
			{ addOn: true, planId: PLAN_IDS.creditTopUp },
			{ planId: PLAN_IDS.pro },
		],
	};

	expect(await makeService().getStorageIncludedBytes()).toBe(
		PLANS[PLAN_IDS.pro].storage.includedBytes,
	);
});

test('an unknown active plan leaves storage issuance retryably undecidable', async () => {
	customerState = {
		subscriptions: [{ planId: 'removed-plan' }],
	};

	expect(makeService().getStorageIncludedBytes()).rejects.toThrow(
		"Active subscription plan 'removed-plan' is not in the catalog",
	);
});

// ----- AI inference policy (the OpenAI-compatible gateway) --------------------

/** Mount the inference policy around a stub completions handler. */
function makeAiApp(downstreamStatus: 200 | 500) {
	const app = withContext(new Hono<CloudEnv>());
	app.use('/v1/chat/completions', chargeOpenAiCreditsWithAutumn);
	app.post('/v1/chat/completions', (c) => c.body(null, downstreamStatus));
	return app;
}

function aiRequest(app: Hono<CloudEnv>, body: unknown) {
	return app.request(
		'/v1/chat/completions',
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		},
		// `c.env` for the real service's `createAutumnClient`; the Autumn client
		// it builds is intercepted by the prototype spies, so the key is inert.
		{ AUTUMN_SECRET_KEY: 'sk_test' },
	);
}

test('a successful completion (200) confirms the reservation', async () => {
	const res = await aiRequest(makeAiApp(200), { model: 'gpt-5.4-mini' });

	expect(res.status).toBe(200);
	expect(finalizeCalls).toEqual(['confirm']);
});

test('a pre-stream failure (>= 400) releases the reservation, never charging', async () => {
	const res = await aiRequest(makeAiApp(500), { model: 'gpt-5.4-mini' });

	expect(res.status).toBe(500);
	expect(finalizeCalls).toEqual(['release']);
});

test('a guard rejection answers in the OpenAI error shape and reserves nothing', async () => {
	checkImpl = () => ({ allowed: false, balance: 0 });

	const res = await aiRequest(makeAiApp(200), { model: 'gpt-5.4-mini' });

	expect(res.status).toBe(402);
	const body = (await res.json()) as {
		error: { code: string; message: string };
	};
	expect(body.error.code).toBe('InsufficientCredits');
	expect(body.error.message).toBeString();
	expect(finalizeCalls).toHaveLength(0);
});

test('an unknown model is rejected before any reservation', async () => {
	const res = await aiRequest(makeAiApp(200), { model: 'not-a-real-model' });

	expect(res.status).toBe(400);
	const body = (await res.json()) as { error: { code: string } };
	expect(body.error.code).toBe('UnknownModel');
	expect(finalizeCalls).toHaveLength(0);
});

// ----- AI transcription policy (the OpenAI-compatible STT gateway) ------------

/**
 * Mount the transcription policy around a stub STT handler. On 200 the handler
 * returns a verbose_json body carrying `duration`, the field the policy reads to
 * settle the per-minute charge after the call.
 */
function makeSttApp(downstream: { status: 200 | 429; duration?: number }) {
	const app = withContext(new Hono<CloudEnv>());
	app.use('/v1/audio/transcriptions', chargeOpenAiTranscriptionCredits);
	app.post('/v1/audio/transcriptions', (c) =>
		c.body(
			JSON.stringify(
				downstream.status === 200
					? { text: 'hi', duration: downstream.duration }
					: { error: { message: 'rate limited', code: 'rate_limit_exceeded' } },
			),
			downstream.status,
			{ 'content-type': 'application/json' },
		),
	);
	return app;
}

function sttRequest(app: Hono<CloudEnv>) {
	const form = new FormData();
	form.append('file', new File([new Uint8Array([1, 2, 3])], 'audio.webm'));
	form.append('model', 'whisper-1');
	return app.request(
		'/v1/audio/transcriptions',
		{
			method: 'POST',
			body: form,
		},
		{ AUTUMN_SECRET_KEY: 'sk_test' },
	);
}

test('an empty wallet is denied (402) before transcribing and nothing is tracked', async () => {
	checkImpl = () => ({ allowed: false, balance: 0 });

	const res = await sttRequest(makeSttApp({ status: 200, duration: 125 }));

	expect(res.status).toBe(402);
	const body = (await res.json()) as { error: { code: string } };
	expect(body.error.code).toBe('InsufficientCredits');
	expect(trackCalls).toHaveLength(0);
});

test('a successful transcription (200) tracks the duration as an async usage event', async () => {
	const res = await sttRequest(makeSttApp({ status: 200, duration: 125 }));

	expect(res.status).toBe(200);
	expect(trackCalls).toHaveLength(1);
	expect(trackCalls[0]).toMatchObject({
		featureId: 'ai_usage',
		value: 3, // ceil(125 / 60)
		async: true,
		properties: { model: 'whisper-1', provider: 'openai', seconds: 125 },
	});
});

test('a non-200 transcription tracks nothing (no charge on failure)', async () => {
	const res = await sttRequest(makeSttApp({ status: 429 }));

	expect(res.status).toBe(429);
	expect(trackCalls).toHaveLength(0);
});

test('a billing-provider outage on the gate fails closed (503) and tracks nothing', async () => {
	checkImpl = () => {
		throw new ConnectionError('Unable to make request');
	};

	const res = await sttRequest(makeSttApp({ status: 200, duration: 60 }));

	expect(res.status).toBe(503);
	expect(trackCalls).toHaveLength(0);
});

// ----- Service STT metering seam (direct, past the policy) --------------------

test('a sub-minute clip floors to a one-credit charge', async () => {
	await makeService().trackAiTranscription({
		seconds: 2,
		model: 'whisper-1',
		provider: 'openai',
	});

	expect(trackCalls[0]?.value).toBe(1);
});

test('a non-finite duration floors to one credit and records zero seconds', async () => {
	await makeService().trackAiTranscription({
		seconds: Number.NaN,
		model: 'whisper-1',
		provider: 'openai',
	});

	expect(trackCalls[0]?.value).toBe(1);
	expect(trackCalls[0]?.properties).toMatchObject({ seconds: 0 });
});

test('an async 202 ack carries no balances and the service reads none', async () => {
	// A 202-shaped body: an object with no `balances` map. The service must not
	// touch a balance, so this resolves Ok regardless of the body.
	trackImpl = async () => ({ id: 'evt_1', code: 'event_received' });

	const { data, error } = await makeService().trackAiTranscription({
		seconds: 60,
		model: 'whisper-1',
		provider: 'openai',
	});

	expect(error).toBeNull();
	expect(data).toBeUndefined();
});

test('a provider failure during metering fails closed as a Result, never a throw', async () => {
	// The gateway already answered the user 200; a metering enqueue failure must
	// be swallowed into a Result the after-response queue logs, not thrown.
	trackImpl = async () => {
		throw new ConnectionError('Unable to make request');
	};

	const { data, error } = await makeService().trackAiTranscription({
		seconds: 60,
		model: 'whisper-1',
		provider: 'openai',
	});

	expect(data).toBeNull();
	expect(error).toMatchObject({ name: 'ProviderRequestFailed' });
});
