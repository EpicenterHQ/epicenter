<!--
	A note editor's failed save (`edit` from a folder's note collection): why,
	Save again, Discard, and Copy for the text that was typed: its title and
	body. A choice (a folder, a model) or a flag is made again, not copied.

	It takes the folder's editor (`error()`, `typed()`), and, until every app
	reads its folder through `reactive`, the getter editor `fromClient` makes.
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';

	/** A read as the folder's editor has it, or as `fromClient`'s getter. */
	type Read<T> = T | (() => T);
	const read = <T,>(value: Read<T>): T =>
		typeof value === 'function' ? (value as () => T)() : value;

	let { edit }: {
		edit: {
			error: Read<{ message: string } | null>;
			typed: Read<{ title?: unknown; body?: unknown } | null>;
			retry(): void;
			discard(): void;
		};
	} = $props();

	const error = $derived(read(edit.error));
	/** The title and body that were typed, the title first. */
	const text = $derived.by(() => {
		const typed = read(edit.typed);
		return [typed?.title, typed?.body]
			.filter((value): value is string => typeof value === 'string' && value !== '')
			.join('\n\n');
	});
</script>

{#if error !== null}
	<Alert.Root variant="destructive" class="gap-2">
		<Alert.Description>Not saved: {error.message}</Alert.Description>
		<div class="flex gap-2">
			<Button size="sm" variant="outline" onclick={() => edit.retry()}>Save again</Button>
			<Button size="sm" variant="ghost" onclick={() => edit.discard()}>Discard</Button>
			{#if text !== ''}
				<Button size="sm" variant="ghost" onclick={() => void navigator.clipboard.writeText(text)}>Copy</Button>
			{/if}
		</div>
	</Alert.Root>
{/if}
