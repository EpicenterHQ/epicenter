/**
 * Reddit ZIP Parsing Tests
 *
 * Verifies hardened ZIP parsing behavior including batched file concatenation,
 * UTF-8 BOM stripping, and graceful handling of missing files.
 *
 * Key behaviors:
 * - Batched CSV files (post_votes_1.csv, post_votes_2.csv) are concatenated into one array
 * - UTF-8 BOM is stripped from decoded CSV text before parsing
 * - Missing CSV files produce empty arrays (not errors)
 */

import { describe, expect, test } from 'bun:test';
import { zipSync } from 'fflate';
import { parseRedditZip } from './parse.js';

/** Create a mock Reddit export ZIP from filename → CSV text entries */
function createZip(entries: Record<string, string>): Blob {
	const files: Record<string, Uint8Array> = {};
	for (const [name, content] of Object.entries(entries)) {
		files[name] = new TextEncoder().encode(content);
	}
	return new Blob([zipSync(files)]);
}

// ============================================================================
// Batched File Parsing (Phase 1.1 + 1.2)
// ============================================================================

describe('batched file parsing', () => {
	test('concatenates split CSVs into a single array', async () => {
		const zip = createZip({
			'post_votes_1.csv':
				'id,permalink,direction\n1,/r/a,up\n2,/r/b,down\n3,/r/c,up',
			'post_votes_2.csv': 'id,permalink,direction\n4,/r/d,up\n5,/r/e,down',
		});

		const result = await parseRedditZip(zip);

		expect(result.post_votes).toHaveLength(5);
		expect(result.post_votes.map((r) => r.id)).toEqual([
			'1',
			'2',
			'3',
			'4',
			'5',
		]);
	});

	test('batched files in a subdirectory are found', async () => {
		const zip = createZip({
			'export/post_votes_1.csv': 'id,permalink,direction\n1,/r/a,up',
			'export/post_votes_2.csv': 'id,permalink,direction\n2,/r/b,down',
		});

		const result = await parseRedditZip(zip);

		expect(result.post_votes.map(({ id }) => id)).toEqual(['1', '2']);
	});
});

// ============================================================================
// BOM Handling (Phase 1.3)
// ============================================================================

describe('BOM handling', () => {
	test('BOM prefix on first CSV header is stripped', async () => {
		const bom = '\uFEFF';
		const zip = createZip({
			'post_votes.csv': `${bom}id,permalink,direction\n1,/r/a,up`,
		});

		const result = await parseRedditZip(zip);

		expect(result.post_votes).toHaveLength(1);
		expect(result.post_votes[0]).toHaveProperty('id', '1');
		expect(result.post_votes[0]).not.toHaveProperty('\uFEFFid');
	});

	test('BOM on non-first file is also stripped', async () => {
		const bom = '\uFEFF';
		const zip = createZip({
			'friends.csv': 'username,note\nalice,hi',
			'posts.csv': `${bom}id,permalink,date,subreddit,gildings\np1,/r/x,2024-01-01,test,0`,
		});

		const result = await parseRedditZip(zip);

		expect(result.posts[0]).toHaveProperty('id', 'p1');
		expect(result.posts[0]).not.toHaveProperty('\uFEFFid');
	});
});

// ============================================================================
// Missing File Handling (regression)
// ============================================================================

describe('missing file handling', () => {
	test('missing CSV file produces empty array', async () => {
		const zip = createZip({
			'friends.csv': 'username,note\nalice,hi',
		});

		const result = await parseRedditZip(zip);

		expect(result.friends).toHaveLength(1);
		expect(result.posts).toEqual([]);
		expect(result.comments).toEqual([]);
		expect(result.post_votes).toEqual([]);
	});
});
