/**
 * Text Diff and Rebase Tests
 *
 * `diffText` finds the changes between two texts by line, then character;
 * `rebase` carries typing onto a text the worker merged, by position.
 *
 * Key behaviors:
 * - The changes turn the first text into the second, for any pair
 * - Typing and a worker's change at different places both survive; where they meet, typing stays with its line
 * - Typing after a sent last line lands inside the conflict block that line went into, on its incoming side
 * - Typing that touches what the worker changed is not rebased
 * - Two change sets compose into one; typing known by its changes is placed exactly, and comes back over the merged text
 * - A body view sees an exact text's changes in the body's positions, the frontmatter's left out
 */
import { expect, test } from 'bun:test';
import { applyChanges, bodyChanges, composeChanges, diffText, rebase } from './diff.js';
import { bodyOf } from './markdown.js';

/** A small seeded generator, so a failure names its seed. */
function random(seed: number) {
	let state = seed;
	return (below: number) => {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
		return state % below;
	};
}
const ALPHABET = ['a', 'b', 'c', '\n', ' ', 'é'];
const text = (next: (below: number) => number, length: number) => Array.from({ length }, () => ALPHABET[next(ALPHABET.length)]).join('');

test('the changes turn the first text into the second, for any pair', () => {
	for (let seed = 1; seed <= 500; seed++) {
		const next = random(seed);
		const a = text(next, next(40));
		const b = next(2) === 0 ? text(next, next(40)) : a.slice(0, next(a.length + 1)) + text(next, next(5)) + a.slice(next(a.length + 1));
		const changes = diffText(a, b);
		expect(applyChanges(a, changes)).toBe(b);
		for (const [index, change] of changes.entries()) expect(change.from).toBeGreaterThanOrEqual(changes[index - 1]?.to ?? 0);
	}
});

test('typing and a worker change at different places both survive, typing first where they meet', () => {
	for (let seed = 1; seed <= 500; seed++) {
		const next = random(seed);
		const sent = text(next, 1 + next(30));
		const at = next(sent.length + 1);
		const there = next(sent.length + 1);
		const typed = `<${seed}>`;
		const theirs = `{${seed}}`;
		const draft = sent.slice(0, at) + typed + sent.slice(at);
		const merged = sent.slice(0, there) + theirs + sent.slice(there);
		const carried = rebase(sent, draft, merged);
		if (carried === null) throw new Error(`seed ${seed}: two insertions do not overlap`);
		expect(applyChanges(draft, carried.changes)).toBe(carried.text);
		// At one point, whole lines the worker inserted at a line start go first; here the worker inserts no newline, so typing does.
		const expected = at <= there ? sent.slice(0, at) + typed + sent.slice(at, there) + theirs + sent.slice(there) : sent.slice(0, there) + theirs + sent.slice(there, at) + typed + sent.slice(at);
		expect(carried.text).toBe(expected);
		// Whole lines inserted at the start of the line typing began: the typing stays with its line, after them.
		const start = sent.lastIndexOf('\n', at - 1) + 1;
		if (start === at) {
			const lines = rebase(sent, draft, `${sent.slice(0, at)}new line\n${sent.slice(at)}`);
			expect(lines?.text).toBe(`${sent.slice(0, at)}new line\n${typed}${sent.slice(at)}`);
		}
	}
});

test('typing after a sent last line lands inside the conflict block that line went into, on its incoming side', () => {
	const block = '<<<<<<< current main - 1\noneR\n||||||| base 2\none\n=======\noneA\n>>>>>>> incoming alice t 3\n';
	expect(rebase('oneA', 'oneABC', block)?.text).toBe(block.replace('oneA\n', 'oneABC\n'));
	// A word typed before the line goes before it, on the same side.
	expect(rebase('oneA', 'so oneA', block)?.text).toBe(block.replace('=======\noneA', '=======\nso oneA'));
});

test('typing that touches what the worker changed is not rebased', () => {
	expect(rebase('alpha\nbeta\n', 'alpha\nbeXta\n', 'alpha\nBETA\n')).toBeNull();
	expect(rebase('one two', 'one', 'one TWO')).toBeNull();
	// Touching is not overlapping: typing at the end of a changed word follows it.
	expect(rebase('alpha\nbeta\n', 'alpha\nbetaY\n', 'alpha\nBETA\n')?.text).toBe('alpha\nBETAY\n');
});

test("a body view sees an exact text's changes in the body's positions, the frontmatter's left out", () => {
	const before = '---\ntitle: A\n---\none\ntwo\n';
	const after = '---\ntitle: Longer\n---\none\nTWO\n';
	const seen = bodyChanges(before, after, diffText(before, after));
	expect(seen.every((change) => change.from >= 4)).toBe(true);
	expect(applyChanges(bodyOf(before), seen)).toBe(bodyOf(after));
	// A header gained crosses the body's edge: the bodies' own diff.
	const plain = 'one\n';
	const headed = '---\ntitle: A\n---\none!\n';
	expect(applyChanges(plain, bodyChanges(plain, headed, diffText(plain, headed)))).toBe('one!\n');
});

test('two change sets compose into one that makes both, for any three texts', () => {
	for (let seed = 1; seed <= 500; seed++) {
		const next = random(seed);
		const [a, b, c] = [text(next, next(30)), text(next, next(30)), text(next, next(30))];
		const composed = composeChanges(diffText(a, b), diffText(b, c), a.length);
		expect(applyChanges(a, composed)).toBe(c);
		for (const [index, change] of composed.entries()) expect(change.from).toBeGreaterThanOrEqual(composed[index - 1]?.to ?? 0);
	}
});

test('typing known by its changes is placed exactly, and comes back over the merged text', () => {
	// The person typed b at the end of ab while the worker inserted X after a: a diff would guess the typed b is the first one.
	const typed = [{ from: 2, to: 2, insert: 'b' }];
	expect(rebase('ab', 'abb', 'aXb', typed)?.text).toBe('aXbb');
	for (let seed = 1; seed <= 300; seed++) {
		const next = random(seed);
		const sent = text(next, 20 + next(20));
		const draft = text(next, 1) + sent + text(next, 2);
		const merged = sent.slice(0, 10) + text(next, 3) + sent.slice(10);
		const carried = rebase(sent, draft, merged);
		if (carried !== null) expect(applyChanges(merged, carried.typed)).toBe(carried.text);
	}
});
