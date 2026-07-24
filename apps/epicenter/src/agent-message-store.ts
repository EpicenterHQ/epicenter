import type { AgentMessage, AgentMessageStore } from '@epicenter/agent';
import type { RowDocument } from '@epicenter/data/runtime';

export type AgentMessageDocumentStore = AgentMessageStore & {
	whenDurable(): Promise<void>;
};

/** Bind the agent loop's structural store seam to one Data row document. */
export function createAgentMessageDocumentStore(
	document: RowDocument,
): AgentMessageDocumentStore {
	const messages = document.get('messages');
	let disposed = false;

	function requireOpen(): void {
		if (disposed) throw new Error('Agent message store is disposed');
	}

	return {
		set(key, value) {
			requireOpen();
			document.transact(() => messages.setAttr(key, value));
		},
		*entries() {
			requireOpen();
			for (const [key, value] of messages.attrEntries()) {
				yield { key: String(key), val: value as AgentMessage };
			}
		},
		observe(handler) {
			requireOpen();
			messages.observe(handler);
			return () => messages.unobserve(handler);
		},
		whenDurable() {
			requireOpen();
			return document.whenDurable();
		},
		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			void document[Symbol.asyncDispose]();
		},
	};
}
