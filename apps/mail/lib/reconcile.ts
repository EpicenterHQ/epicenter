/** ADR-0199: drain before pull and retire only carried (message, label, seq) rows.
 * A 400/404 discards and reports those rows; other errors stop and keep them. */
import { type Gmail, GmailError } from './gmail.js';
import type { Store } from './store.js';

export async function pull(store: Store, gmail: Gmail) {
	const messages = await gmail.listMessages();
	const labels = await gmail.listLabels();
	const { historyId: cursor } = await gmail.getProfile();
	store.replaceMirror({ messages, labels, cursor });
	return {
		messages: messages.length,
		labels: labels.length,
		cursor,
		refreshedAt: store.status().refreshedAt!,
		pending: store.pendingSummary().count,
	};
}

export async function reconcilePass(store: Store, gmail: Gmail) {
	const delivered: { id: string; added: string[]; removed: string[] }[] = [];
	const discarded: { id: string; labels: string[]; reason: string }[] = [];
	let failure: string | undefined;
	const groups = new Map<string, ReturnType<Store['pendingRows']>>();
	for (const row of store.pendingRows())
		groups.set(row.message_id, [...(groups.get(row.message_id) ?? []), row]);
	for (const [id, rows] of groups) {
		const added = rows.filter((i) => i.want === 1).map((i) => i.label_id);
		const removed = rows.filter((i) => i.want === 0).map((i) => i.label_id);
		try {
			const message = await gmail.modifyMessage(id, {
				addLabelIds: added,
				removeLabelIds: removed,
			});
			store.foldLabels(id, message.labelIds ?? []);
			store.retire(rows);
			delivered.push({ id, added, removed });
		} catch (error) {
			if (
				error instanceof GmailError &&
				(error.status === 400 || error.status === 404)
			) {
				store.retire(rows);
				discarded.push({
					id,
					labels: rows.map((i) => i.label_id),
					reason: error.message,
				});
				continue;
			}
			failure = error instanceof Error ? error.message : String(error);
			break;
		}
	}
	try {
		await pull(store, gmail);
	} catch (error) {
		failure = [failure, error instanceof Error ? error.message : String(error)]
			.filter(Boolean)
			.join('; ');
	}
	return {
		delivered,
		discarded,
		...(failure ? { failure } : {}),
		pending: store.pendingSummary().count,
		refreshedAt: store.status().refreshedAt,
	};
}
