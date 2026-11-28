<!-- A keyboard shortcut as a key cap, sized by the text around it. -->
<script lang="ts">
	import { cn } from '@epicenter/ui/utils';

	let { keys, class: className }: { keys: string; class?: string } = $props();
</script>

<kbd class={cn('rounded-md border border-b-2 bg-muted px-1.5 font-sans font-medium', className)}>{keys}</kbd>
