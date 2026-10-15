<!--
	The notice every app shows when a save replaced another writer's change
	(ADR-0551): it names each value the save kept over theirs, and offers
	"Restore theirs", which the app runs as one more save of
	`restoreTheirs(saved)` from `@epicenter/folder`.

	Shown inline, as the Folders window lists them, or as a toast that stays
	until it is dismissed:

	```ts
	import { toastReplaced } from '@epicenter/svelte/replaced-notice';
	toastReplaced({ saved, subject: 'Milk', restore: () => save(restoreTheirs(saved)) });
	```
-->
<script module lang="ts">
	import type { Replaced } from '@epicenter/folder';
	import ReplacedNotice from './replaced-notice.svelte';

	/** At most this many characters of a value are shown. */
	const SHOWN = 80;

	const clipped = (text: string) =>
		text.length > SHOWN ? `${text.slice(0, SHOWN - 1)}…` : text;

	/** A JSON value as a person reads it. */
	const valueText = (value: unknown) =>
		value === undefined ? 'nothing' : clipped(JSON.stringify(value));

	/** Lines as a person reads them, without the last line feed. */
	const linesText = (text: string) =>
		text === '' ? 'no lines' : `"${clipped(text.replace(/\n$/, ''))}"`;

	/** Where a region stands: one line, or a span of them, counted from 1. */
	function linesAt(line: number, kept: string) {
		const count = (kept.match(/[^\n]*\n|[^\n]+$/g) ?? []).length;
		return count > 1 ? `lines ${line + 1}-${line + count}` : `line ${line + 1}`;
	}

	/**
	 * Each value one replaced entry names, for a person: what the save kept,
	 * and what was theirs. A text entry names each competing span.
	 */
	export function describeReplaced(item: Replaced): string[] {
		switch (item.kind) {
			case 'field':
				return [`${item.field}: kept ${valueText(item.kept)}; theirs was ${valueText(item.theirs)}`];
			case 'setting':
				return [`${item.key}: kept ${valueText(item.kept)}; theirs was ${valueText(item.theirs)}`];
			case 'text': {
				const part = item.part === 'body' ? 'Text' : 'File';
				return item.regions.map(
					(region) =>
						`${part}, ${linesAt(region.line, region.kept)}: kept ${linesText(region.kept)}; theirs was ${linesText(region.theirs)}`,
				);
			}
			case 'whole':
				return ['The whole file: yours was kept over theirs'];
		}
	}

	/**
	 * Show the notice as a toast that stays until it is dismissed or "Restore
	 * theirs" is pressed, in the app's `Toaster`. Nothing is shown when
	 * nothing was replaced.
	 */
	export async function toastReplaced({
		replaced,
		subject,
		restore,
	}: {
		replaced: readonly Replaced[];
		subject?: string;
		/** One more save, of `restoreTheirs(saved)`. */
		restore: () => void;
	}) {
		if (replaced.length === 0) return;
		// Loaded when a notice is shown, so a page without a Toaster loads none.
		const { toast } = await import('@epicenter/ui/sonner');
		const id = toast.custom(ReplacedNotice, {
			duration: Number.POSITIVE_INFINITY,
			componentProps: {
				replaced,
				subject,
				onRestore: () => {
					toast.dismiss(id);
					restore();
				},
				onDismiss: () => toast.dismiss(id),
			},
		});
	}
</script>

<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';

	let {
		replaced,
		subject,
		disabled = false,
		onRestore,
		onDismiss,
	}: {
		/** What one save replaced of another writer's change. */
		replaced: readonly Replaced[];
		/** What was saved, as the person knows it: a title or a file name. */
		subject?: string;
		/** A save is running: the buttons wait. */
		disabled?: boolean;
		onRestore: () => void;
		onDismiss: () => void;
	} = $props();

	const lines = $derived(replaced.flatMap(describeReplaced));
</script>

<Alert.Root role="status" aria-label="Saved over a change made elsewhere">
	<Alert.Title>
		Saved over a change made elsewhere{subject === undefined ? '' : ` to ${subject}`}
	</Alert.Title>
	<Alert.Description>
		<ul class="flex flex-col gap-0.5">
			{#each lines as line, index (index)}
				<li class="break-words">{line}</li>
			{/each}
		</ul>
		<div class="mt-2 flex gap-2">
			<Button size="sm" variant="outline" {disabled} onclick={onRestore}>
				Restore theirs
			</Button>
			<Button size="sm" variant="ghost" {disabled} onclick={onDismiss}>Dismiss</Button>
		</div>
	</Alert.Description>
</Alert.Root>
