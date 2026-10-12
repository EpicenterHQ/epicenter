/**
 * New Capture Composition Tests
 *
 * A capture must be the same thing when reopened as when it was created, and
 * the original text's own list must never become this app's thoughts. These
 * tests parse the composed file again, as reopening does, and compare bytes.
 *
 * Key behaviors:
 * - Ordinary text is followed by the section, with thoughts when given
 * - Text with its own Thoughts list, then an open fence, gets one visible
 *   heading before it: two headings, refused on reopening, bytes intact
 * - The legacy import writes the same file and reports it as source-only
 *
 * See `document.test.ts` for an open fence absorbing the appended section.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frameRowText } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/bun';
import { expectOk } from 'wellcrafted/testing';
import { captureBody, captureDefinition, composeBody } from './index.js';
import { runLegacyImport } from './legacy/index.js';

const HEAD = '---\ncapturedAt: 2026-01-01T00:00:00.000Z\n---\n';
const OWN_LIST_THEN_OPEN_FENCE =
	'Pasted article\n\n## Thoughts\n\n- This belongs to the original article\n\n```\nnever closed';

/** A whole file read again the way an open capture reads its row's body. */
function reopen(source: string) {
	const frame = frameRowText(source);
	if (frame.kind !== 'frontmatter') throw new Error('fixture');
	const { data, error } = captureBody.decode(source.slice(frame.bodyStart));
	return {
		refusal: error ?? undefined,
		text: data?.text,
		thoughts: data?.thoughts ?? [],
	};
}

const roots: string[] = [];
afterAll(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

test('ordinary text is followed by the section and its thoughts', () => {
	expect(composeBody('Text', ['one', 'two\nlines', '  '])).toEqual({
		body: '\nText\n\n## Thoughts\n\n- one\n- two\n  lines\n-\n',
		refusal: undefined,
		absorbed: false,
	});
	const reopened = reopen(HEAD + composeBody('Text', ['one']).body);
	expect(reopened.text).toBe('Text');
	expect(reopened.thoughts).toEqual(['one']);
});

test('its own Thoughts list then an open fence: marked, refused on reopening, bytes intact', () => {
	const composed = composeBody(OWN_LIST_THEN_OPEN_FENCE);
	expect(composed.body).toBe(
		`\n## Thoughts\n\n${OWN_LIST_THEN_OPEN_FENCE}\n\n## Thoughts\n`,
	);
	expect(composed.refusal?.code).toBe('duplicate-heading');
	expect(composed.absorbed).toBe(true);

	const reopened = reopen(HEAD + composed.body);
	expect(reopened.refusal?.code).toBe('duplicate-heading');
	expect(reopened.thoughts).toEqual([]);
	expect(reopened.text).toBeUndefined();
	const refused = captureBody.encode(
		{ text: 'mine', thoughts: [] },
		composed.body,
	);
	expect(refused.error?.code).toBe('duplicate-heading');
	// Without the mark, the article's list would have read as thoughts.
	const unmarked = reopen(
		`${HEAD}\n${OWN_LIST_THEN_OPEN_FENCE}\n\n## Thoughts\n`,
	);
	expect(unmarked.thoughts).toEqual(['This belongs to the original article']);
});

test('the legacy import writes the marked file and reports it as source-only', async () => {
	const root = await mkdtemp(join(tmpdir(), 'capture-compose-'));
	roots.push(root);
	const folder = expectOk(
		await openFolder({
			root,
			definition: captureDefinition,
			git: {
				author: { name: 'Test', email: 'test@localhost' },
			},
		}),
	);
	const report = await runLegacyImport(folder.files, {
		format: 'epicenter.capture.legacy-bundle',
		version: 1,
		exportedAt: '2026-10-01T02:30:00.000Z',
		source: {
			storeId: 'so.epicenter.capture',
			account: { authorityId: 'a', principalId: 'p' },
			scope: 'local-replica',
		},
		captures: [
			{
				id: 'c1',
				capturedAt: '2026-01-01T00:00:00.000Z',
				text: OWN_LIST_THEN_OPEN_FENCE,
			},
		],
		thoughts: [{ id: 't1', captureId: 'c1', position: 0, text: 'app thought' }],
		entries: [],
		unreadable: [],
		promotionCount: 0,
	});
	const [document] = report.documents;
	expect(document?.structured?.code).toBe('duplicate-heading');
	const saved = await readFile(join(root, document?.path ?? ''), 'utf8');
	expect(saved).toBe(
		`---\ncapturedAt: "2026-01-01T00:00:00.000Z"\nimportedFrom: so.epicenter.capture/captures/c1\n---\n\n## Thoughts\n\n${OWN_LIST_THEN_OPEN_FENCE}\n\n## Thoughts\n\n- app thought\n`,
	);
	const reopened = reopen(saved);
	expect(reopened.refusal?.code).toBe('duplicate-heading');
	expect(reopened.thoughts).toEqual([]);
	await folder.close();
});
