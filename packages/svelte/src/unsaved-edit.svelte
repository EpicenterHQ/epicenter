<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';

	let { draft }: {
		draft: {
			value: unknown;
			error: { message: string } | null;
			retry(): void;
			discard(): void;
		};
	} = $props();
</script>

{#if draft.error !== null}
	<Alert.Root variant="destructive" class="gap-2">
		<Alert.Description>Not saved: {draft.error.message}</Alert.Description>
		<div class="flex gap-2">
			<Button size="sm" variant="outline" onclick={() => draft.retry()}>Save again</Button>
			<Button size="sm" variant="ghost" onclick={() => draft.discard()}>Discard</Button>
			{#if typeof draft.value === 'string'}
				<Button size="sm" variant="ghost" onclick={() => {
					if (typeof draft.value === 'string') void navigator.clipboard.writeText(draft.value);
				}}>Copy</Button>
			{/if}
		</div>
	</Alert.Root>
{/if}
