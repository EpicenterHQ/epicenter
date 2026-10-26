<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';

	let { edit }: {
		edit: {
			value: unknown;
			error: { message: string } | null;
			retry(): void;
			discard(): void;
		};
	} = $props();
</script>

{#if edit.error !== null}
	<Alert.Root variant="destructive" class="gap-2">
		<Alert.Description>Not saved: {edit.error.message}</Alert.Description>
		<div class="flex gap-2">
			<Button size="sm" variant="outline" onclick={() => edit.retry()}>Save again</Button>
			<Button size="sm" variant="ghost" onclick={() => edit.discard()}>Discard</Button>
			{#if typeof edit.value === 'string'}
				<Button size="sm" variant="ghost" onclick={() => {
					if (typeof edit.value === 'string') void navigator.clipboard.writeText(edit.value);
				}}>Copy</Button>
			{/if}
		</div>
	</Alert.Root>
{/if}
