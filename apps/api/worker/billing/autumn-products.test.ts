import { expect, test } from 'bun:test';
import { creditTopUp, free, pro } from './autumn-products.js';
import { FEATURE_IDS, PLAN_IDS, PLANS } from './catalog.js';

test('the automatically enabled free plan grants storage without a price', () => {
	expect(free.autoEnable).toBe(true);
	expect(free.price).toBeUndefined();
	expect(free.items?.every((item) => item.price === undefined)).toBe(true);
	expect(
		free.items?.find((item) => item.featureId === FEATURE_IDS.storageBytes),
	).toEqual({
		featureId: FEATURE_IDS.storageBytes,
		included: PLANS[PLAN_IDS.free].storage.includedBytes,
	});
});

test('paid storage retains its overage price and top-ups charge once', () => {
	expect(
		pro.items?.find((item) => item.featureId === FEATURE_IDS.storageBytes)
			?.price,
	).toMatchObject({
		amount: 1,
		interval: 'month',
		billingMethod: 'usage_based',
	});
	expect(creditTopUp.items?.[0]?.price).toMatchObject({
		interval: 'one_off',
		billingMethod: 'prepaid',
	});
	expect(creditTopUp.items?.[0]?.reset).toBeUndefined();
});
