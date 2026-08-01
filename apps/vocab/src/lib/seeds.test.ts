/**
 * Seed tests.
 *
 * The contracts that matter are the ones a learner would notice: a seed opens a
 * findable conversation, two seeds never collide in the list, and the offer is a
 * distinct draw rather than the same three every time. The prose of an opening
 * line is a taste call, not a contract, so nothing here asserts it.
 */

import { describe, expect, test } from 'bun:test';
import { CONVERSATION_SEEDS, sampleSeeds } from './seeds.js';

/** A run of Han ideographs, the same range the pinyin overlay reads. */
const HAS_HAN = /[一-鿿]/;

describe('CONVERSATION_SEEDS', () => {
	test('every seed opens a titled conversation with a first turn', () => {
		for (const seed of CONVERSATION_SEEDS) {
			expect(seed.title.trim()).not.toBe('');
			expect(seed.opening.trim()).not.toBe('');
		}
	});

	// The shared registry's auto-title only overwrites 'New Chat'. Colliding with
	// that placeholder would hand the conversation back to the auto-title and name
	// it after the first fifty characters of the seed's own opening line.
	test('no seed title is the blank-conversation placeholder', () => {
		for (const seed of CONVERSATION_SEEDS) {
			expect(seed.title).not.toBe('New Chat');
		}
	});

	test('titles are distinct, so two seeded conversations stay tellable apart', () => {
		const titles = CONVERSATION_SEEDS.map((seed) => seed.title);
		expect(new Set(titles).size).toBe(titles.length);
	});

	test('every opening turn is Chinese, not an English request for Chinese', () => {
		for (const seed of CONVERSATION_SEEDS) {
			expect(HAS_HAN.test(seed.opening)).toBe(true);
		}
	});
});

describe('sampleSeeds', () => {
	test('draws the asked-for number of distinct seeds', () => {
		// Random, so a single draw proves little; repeat enough to catch a
		// with-replacement bug that would occasionally repeat a seed.
		for (let attempt = 0; attempt < 100; attempt++) {
			const drawn = sampleSeeds(3);
			expect(drawn).toHaveLength(3);
			expect(new Set(drawn.map((seed) => seed.title)).size).toBe(3);
		}
	});

	test('draws only from the committed list', () => {
		for (const seed of sampleSeeds(CONVERSATION_SEEDS.length)) {
			expect(CONVERSATION_SEEDS).toContain(seed);
		}
	});

	test('asking for more than exists returns the whole list rather than looping', () => {
		expect(sampleSeeds(CONVERSATION_SEEDS.length + 5)).toHaveLength(
			CONVERSATION_SEEDS.length,
		);
	});

	test('asking for none draws none', () => {
		expect(sampleSeeds(0)).toEqual([]);
	});
});
