<script lang="ts">
	import { fromSubscription } from '@epicenter/svelte';
	import * as Modal from '@epicenter/ui/modal';
	import { getRecordingEditor } from '$lib/whispering/context';
	import RecordingDetailForm from './RecordingDetailForm.svelte';

	const editor = getRecordingEditor();
	const state = fromSubscription(editor.subscribe, () => editor.state);
</script>

<Modal.Root
	bind:open={
		() => state.current.isOpen, (open) => { if (!open) editor.close(); }
	}
>
	{#if state.current.active}
		{#key state.current.active.recording.id}
			<RecordingDetailForm active={state.current.active} isOpen={state.current.isOpen} />
		{/key}
	{/if}
</Modal.Root>
