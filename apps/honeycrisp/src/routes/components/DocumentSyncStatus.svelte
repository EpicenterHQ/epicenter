<script lang="ts">
	import type {
		connectRecordDocument,
		RecordDocumentConnectionStatus,
	} from '@epicenter/document-sync';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';

	let {
		connection,
	}: { connection: ReturnType<typeof connectRecordDocument> } = $props();

	const source = $derived(connection);
	let status = $state<RecordDocumentConnectionStatus>('connecting');
	$effect(() => {
		status = source.status;
		return source.subscribeStatus((next) => (status = next));
	});

	const notice = $derived.by(() => {
		switch (status) {
			case 'offline':
				return 'Offline; edits are saved on this device and will sync when reconnected.';
			case 'revoked':
				return 'This note was deleted and can no longer sync.';
			case 'refused':
				return 'This note cannot sync because its document was refused.';
			case 'connecting':
			case 'connected':
			case 'authentication-required':
			case 'disposed':
				return undefined;
		}
	});
</script>

{#if notice}
	<div
		class="flex items-center gap-2 border-t px-4 py-1.5 text-xs text-muted-foreground"
	>
		<TriangleAlertIcon class="size-3.5 shrink-0" />
		<span>{notice}</span>
	</div>
{/if}
