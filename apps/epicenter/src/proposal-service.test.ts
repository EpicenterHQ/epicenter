/**
 * Home Proposal service tests.
 *
 * Verifies that Home publishes a bounded Lens catalog, parses exact selections,
 * and delegates artifact custody to the desktop record owner.
 */
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopRecordEpicenterOwner } from '@epicenter/data/desktop-record-owner';
import { defineLens, defineTable } from '@epicenter/data/record';
import { field } from '@epicenter/field';

import { createProposalService } from './proposal-service.ts';

const lens = defineLens({
	namespace: 'so.epicenter.proposaltest',
	title: 'Notes',
	description: 'Proposal service fixture.',
	collections: {
		notes: defineTable({
			title: 'Notes',
			fields: { title: field.string() },
			optional: [],
		}),
	},
});

test('Home lists its Lens catalog and owns Proposal artifact custody', async () => {
	const directory = await mkdtemp(
		join(tmpdir(), 'epicenter-proposal-service-'),
	);
	const owner = await createDesktopRecordEpicenterOwner({ directory });
	const proposals = createProposalService({
		owner,
		lenses: { chat: lens, honeycrisp: lens, whispering: lens },
	});
	try {
		const empty = await proposals.list();
		expect(empty.proposals).toEqual([]);
		expect(empty.lenses[0]).toEqual({
			id: 'chat',
			title: 'Notes',
			description: 'Proposal service fixture.',
			namespace: 'so.epicenter.proposaltest',
			collections: [{ key: 'notes', title: 'Notes', kind: 'table' }],
		});

		const proposal = await proposals.create({
			lens: 'chat',
			selection: {
				namespace: lens.namespace,
				collections: {
					notes: { kind: 'table', recordKeys: [], allowCreate: true },
				},
			},
		});
		expect(await Bun.file(proposal.path).exists()).toBe(true);
		expect((await proposals.list()).proposals).toEqual([proposal]);
		await expect(
			proposals.create({ lens: 'chat', selection: null }),
		).rejects.toThrow(/must be an object/);

		await proposals.delete(proposal.id);
		expect(await proposals.list()).toEqual({
			lenses: empty.lenses,
			proposals: [],
		});
	} finally {
		await owner[Symbol.asyncDispose]();
		await rm(directory, { recursive: true, force: true });
	}
});
