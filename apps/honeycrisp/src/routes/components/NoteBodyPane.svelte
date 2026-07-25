<script lang="ts">
	import type { NoteId } from '@epicenter/honeycrisp';
	import { Loading } from '@epicenter/ui/loading';
	import HoneycripEditor from '$lib/editor/Editor.svelte';
	import { getHoneycrispApp } from '$lib/context.js';
	import { runHoneycrispMutation } from '$lib/mutation.js';

	const honeycrisp = getHoneycrispApp();

	let { noteId, focusRequest }: { noteId: NoteId; focusRequest: number } =
		$props();

	/**
	 * How often an open note asks the authority for newer accepted state.
	 *
	 * Opening a document means local readiness, not remote freshness
	 * (ADR-0171), so refresh timing is Honeycrisp's choice. Notes are edited by
	 * one person far more often than two, so this trades collaboration latency
	 * for quiet: pull once as soon as the note renders, again whenever the tab
	 * regains visibility, and otherwise on a slow tick while it is on screen.
	 */
	const PULL_INTERVAL_MS = 15_000;

	const lease = $derived(honeycrisp.openNoteDocument(noteId));
	$effect(() => {
		const openedLease = lease;
		return () =>
			void openedLease.then(
				(opened) => opened[Symbol.asyncDispose](),
				() => undefined,
			);
	});

	$effect(() => {
		const openedLease = lease;
		let isCancelled = false;

		// A failed pull is not an error the reader needs: the note stays open and
		// editable, and the next tick simply tries again.
		const pull = () =>
			void openedLease.then(
				(opened) => {
					if (!isCancelled) void opened.pull();
				},
				() => undefined,
			);

		pull();
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') pull();
		}, PULL_INTERVAL_MS);
		const onVisible = () => {
			if (document.visibilityState === 'visible') pull();
		};
		document.addEventListener('visibilitychange', onVisible);

		return () => {
			isCancelled = true;
			clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});
</script>

{#await lease}
	<Loading class="h-full" />
{:then noteDocument}
	<div class="flex h-full flex-col">
		<div class="min-h-0 flex-1">
			<HoneycripEditor
				yxmlfragment={noteDocument.get('body')}
				{focusRequest}
				onContentChange={(change) =>
					runHoneycrispMutation(
						honeycrisp.state.notes.updateContent(noteId, change),
						'Could not save note',
					)}
			/>
		</div>
	</div>
{/await}
