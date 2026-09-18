<script lang="ts">
	import TranscriptionModelPicker from '../../TranscriptionModelPicker.svelte';
	let { class: className, iconViewTransitionName }: {
		class?: string;
		variant: 'standalone' | 'pipeline';
		iconViewTransitionName?: string;
	} = $props();
</script>

<div class={className} style:view-transition-name={iconViewTransitionName}>
	<TranscriptionModelPicker />
</div>
