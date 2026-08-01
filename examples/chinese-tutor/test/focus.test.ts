/**
 * Focus caps: the tutor is handed a small target set, and the bound is enforced
 * in code rather than requested in a prompt.
 *
 * Also the negative claim that makes this not-a-scheduler: selection is a pure
 * function of the pool, so running a session changes nothing about what the next
 * session selects. Only the human moving a phrase's `stage` does.
 */

import { describe, expect, test } from 'bun:test';
import {
	FOCUS_CAPS,
	PRACTICE_FOCUS_CAP,
	REVISIT_FOCUS_CAP,
	selectPracticeFocus,
	selectRevisitFocus,
} from '../src/focus.ts';
import {
	compileRevisitContext,
	REVISIT_EXCERPT_TURNS,
	REVISIT_SESSION_CAP,
} from '../src/revisit.ts';
import type { SavedPhrase } from '../src/saved.ts';
import { openSession } from '../src/session.ts';
import { PHRASES, SESSIONS } from './fixtures.ts';

const sources = { phrases: PHRASES, sessions: SESSIONS };

function pool(size: number): SavedPhrase[] {
	return Array.from({ length: size }, (_, index) => ({
		id: `x${index}`,
		text: `词${index}`,
		note: '',
		stage: 'new' as const,
		createdAt: index,
	}));
}

describe('practice focus', () => {
	test('is capped even when the pool is large', () => {
		expect(selectPracticeFocus(pool(200))).toHaveLength(PRACTICE_FOCUS_CAP);
	});

	test('excludes phrases the human marked usable', () => {
		const focus = selectPracticeFocus(PHRASES, { cap: 100 });
		expect(focus.map((phrase) => phrase.text)).not.toContain('谢谢');
		expect(focus.every((phrase) => phrase.stage !== 'usable')).toBe(true);
	});

	test('orders new before understood, then oldest first', () => {
		expect(
			selectPracticeFocus(PHRASES, { cap: 100 }).map((phrase) => phrase.text),
		).toEqual(['学习', '练习', '服务员', '买单', '你好', '点菜', '好吃']);
	});

	test('a zero cap yields nothing rather than throwing', () => {
		expect(selectPracticeFocus(PHRASES, { cap: 0 })).toEqual([]);
		expect(selectPracticeFocus(PHRASES, { cap: -3 })).toEqual([]);
	});

	test('selection is pure: repeated calls agree and the pool is unchanged', () => {
		const before = JSON.stringify(PHRASES);
		expect(selectPracticeFocus(PHRASES)).toEqual(selectPracticeFocus(PHRASES));
		expect(JSON.stringify(PHRASES)).toBe(before);
	});
});

describe('revisit focus', () => {
	test('is capped', () => {
		expect(selectRevisitFocus(pool(200), { transcript: pool(200).map((p) => p.text).join('') })).toHaveLength(
			REVISIT_FOCUS_CAP,
		);
	});

	test('with a transcript, keeps only phrases that occurred in it', () => {
		const focus = selectRevisitFocus(PHRASES, { transcript: '我要点菜，好吃吗？' });
		expect(focus.map((phrase) => phrase.text).sort()).toEqual(['好吃', '点菜']);
	});

	test('with no transcript, falls back to understood phrases', () => {
		expect(selectRevisitFocus(PHRASES).map((phrase) => phrase.text)).toEqual([
			'你好',
			'点菜',
			'好吃',
		]);
	});
});

describe('revisit context caps', () => {
	test('draws from at most REVISIT_SESSION_CAP sessions, most recent first', () => {
		const many = Array.from({ length: 10 }, (_, index) => ({
			id: `s${index}`,
			intent: 'chat' as const,
			startedAt: index,
			turns: [{ role: 'user' as const, text: 'restaurant' }],
		}));
		const context = compileRevisitContext(many, { topic: 'restaurant' });
		expect(context.sessions).toHaveLength(REVISIT_SESSION_CAP);
		expect(context.sessions.map((session) => session.id)).toEqual([
			's9',
			's8',
			's7',
		]);
	});

	test('quotes only the tail of each session', () => {
		const long = {
			id: 'long',
			intent: 'chat' as const,
			startedAt: 1,
			turns: Array.from({ length: 20 }, (_, index) => ({
				role: 'user' as const,
				text: `line ${index}`,
			})),
		};
		const context = compileRevisitContext([long]);
		expect(context.excerpt.split('\n')).toHaveLength(REVISIT_EXCERPT_TURNS);
		expect(context.excerpt).toContain('line 19');
		expect(context.excerpt).not.toContain('line 0');
	});

	test('an unmatched topic compiles to nothing', () => {
		const context = compileRevisitContext(SESSIONS, { topic: 'astrophysics' });
		expect(context.sessions).toEqual([]);
		expect(context.excerpt).toBe('');
		expect(context.transcript).toBe('');
	});
});

describe('caps reach the seed', () => {
	test('every opening respects its declared cap', () => {
		expect(openSession({ intent: 'chat' }, sources).focus).toHaveLength(
			FOCUS_CAPS.chat,
		);
		expect(openSession({ intent: 'conversation' }, sources).focus).toHaveLength(
			FOCUS_CAPS.conversation,
		);
		expect(
			openSession({ intent: 'practice' }, { ...sources, phrases: pool(200) })
				.focus.length,
		).toBeLessThanOrEqual(FOCUS_CAPS.practice);
		expect(
			openSession({ intent: 'revisit' }, { ...sources, phrases: pool(200) })
				.focus.length,
		).toBeLessThanOrEqual(FOCUS_CAPS.revisit);
	});

	test('a caller may tighten the cap but the seed still holds it', () => {
		const seed = openSession({ intent: 'practice', cap: 2 }, sources);
		expect(seed.focus).toHaveLength(2);
		expect(seed.systemPrompt).toContain('学习');
		expect(seed.systemPrompt).not.toContain('服务员');
	});
});
