import { describe, expect, test } from 'bun:test';
import { describeAssertion, invert, planLabel, planToggle } from './actions';

describe('planToggle', () => {
	test('inbox toggles on presence of INBOX', () => {
		expect(planToggle(['INBOX', 'UNREAD'], 'inbox')).toEqual({
			label: 'Archived',
			labelId: 'INBOX',
			want: false,
		});
		expect(planToggle(['UNREAD'], 'inbox')).toEqual({
			label: 'Moved to inbox',
			labelId: 'INBOX',
			want: true,
		});
	});

	test('read toggles on presence of UNREAD', () => {
		expect(planToggle(['UNREAD'], 'read')).toEqual({
			label: 'Marked read',
			labelId: 'UNREAD',
			want: false,
		});
		expect(planToggle(['INBOX'], 'read')).toEqual({
			label: 'Marked unread',
			labelId: 'UNREAD',
			want: true,
		});
	});

	test('star toggles on presence of STARRED', () => {
		expect(planToggle(['STARRED'], 'star')).toEqual({
			label: 'Unstarred',
			labelId: 'STARRED',
			want: false,
		});
		expect(planToggle([], 'star')).toEqual({
			label: 'Starred',
			labelId: 'STARRED',
			want: true,
		});
	});
});

describe('planLabel', () => {
	test('removes a present label, adds an absent one', () => {
		expect(planLabel('Label_1', 'Receipts', true)).toEqual({
			label: 'Removed Receipts',
			labelId: 'Label_1',
			want: false,
		});
		expect(planLabel('Label_1', 'Receipts', false)).toEqual({
			label: 'Added Receipts',
			labelId: 'Label_1',
			want: true,
		});
	});
});

describe('invert', () => {
	test('is a true inverse: flips the desired label presence', () => {
		const archive = planToggle(['INBOX'], 'inbox');
		const undo = invert(archive);
		expect(undo.labelId).toBe('INBOX');
		expect(undo.want).toBe(true);
		// Inverting twice returns the original payload.
		expect(invert(undo)).toEqual(archive);
	});
});

describe('describeAssertion', () => {
	test('names an assertion with the same verb that planned it', () => {
		// The two directions have to agree or the outbox tells a person their
		// archive is a different act than the one they made.
		const archive = planToggle(['INBOX'], 'inbox');
		expect(archive.labelId).toBe('INBOX');
		expect(archive.want).toBe(false);
		expect(describeAssertion('INBOX', false)).toBe('Archive');
		expect(describeAssertion('INBOX', true)).toBe('Move to inbox');
		expect(describeAssertion('TRASH', true)).toBe('Move to trash');
		expect(describeAssertion('UNREAD', false)).toBe('Mark read');
		expect(describeAssertion('STARRED', true)).toBe('Star');
	});

	test('a custom label is named, and falls back to its id', () => {
		expect(describeAssertion('Label_7', true, 'Receipts')).toBe('Add Receipts');
		// The cache a name would have come from is disposable, so an outbox row
		// that outlived it still has to say something (ADR-0306).
		expect(describeAssertion('Label_7', false)).toBe('Remove Label_7');
	});
});
