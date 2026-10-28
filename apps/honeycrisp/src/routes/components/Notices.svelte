<!--
	What happened to this device's saved changes that the person should
	know: a change the server refused, one dropped or saved as a copy, or one
	the server could not take, whose text is kept to copy. Each stays until
	dismissed; none syncs.
-->
<script lang="ts">
	import type { Live, Notice } from '@epicenter/repository';
	import { live } from '@epicenter/repository/svelte';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';

	let { notices }: { notices: { live(): Live<Notice[]>; dismiss(id: number): Promise<void> } } = $props();

	// svelte-ignore state_referenced_locally
	const list = live(notices.live());

	const title: Record<Notice['kind'], string> = {
		refused: 'A change was refused',
		dropped: 'A change had nothing left to change',
		relocated: 'A change was saved as a copy',
		protocol: 'A change could not be saved to the server',
	};
</script>

{#if (list.current?.length ?? 0) > 0}
	<section aria-label="Notices" class="flex max-h-48 shrink-0 flex-col gap-2 overflow-y-auto border-b p-2">
		{#each list.current ?? [] as notice (notice.id)}
			<Alert.Root variant={notice.kind === 'relocated' ? 'default' : 'warning'}>
				<Alert.Title>{title[notice.kind]}</Alert.Title>
				<Alert.Description>
					<span class="font-mono text-xs">{notice.path}</span>: {notice.reason}.
					{#if notice.kept !== null}This device shows the server's text again; copy what it showed to keep it.{/if}
				</Alert.Description>
				<Alert.Action class="flex gap-1">
					{#if notice.kept !== null}
						{@const kept = notice.kept}
						<Button variant="outline" size="sm" onclick={() => void navigator.clipboard.writeText(kept)}>Copy text</Button>
					{/if}
					<Button variant="ghost" size="sm" onclick={() => void notices.dismiss(notice.id)}>Dismiss</Button>
				</Alert.Action>
			</Alert.Root>
		{/each}
	</section>
{/if}
