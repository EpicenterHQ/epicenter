<!--
	A note editor's failed save (`edit` from `@epicenter/svelte/client`): why,
	Save again, Discard, and Copy for the text that was typed: its title and
	body. A choice (a folder, a model) or a flag is made again, not copied.
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';

	let { edit }: {
		edit: {
			error: { message: string } | null;
			typed: { title?: unknown; body?: unknown } | null;
			retry(): void;
			discard(): void;
		};
	} = $props();

	/** The title and body that were typed, the title first. */
	const text = $derived(
		[edit.typed?.title, edit.typed?.body]
			.filter((value): value is string => typeof value === 'string' && value !== '')
			.join('\n\n'),
	);
</script>

{#if edit.error !== null}
	<Alert.Root variant="destructive" class="gap-2">
		<Alert.Description>Not saved: {edit.error.message}</Alert.Description>
		<div class="flex gap-2">
			<Button size="sm" variant="outline" onclick={() => edit.retry()}>Save again</Button>
			<Button size="sm" variant="ghost" onclick={() => edit.discard()}>Discard</Button>
			{#if text !== ''}
				<Button size="sm" variant="ghost" onclick={() => void navigator.clipboard.writeText(text)}>Copy</Button>
			{/if}
		</div>
	</Alert.Root>
{/if}
