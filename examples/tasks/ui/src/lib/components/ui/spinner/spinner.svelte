<script lang="ts">
	import Loader2Icon from '@lucide/svelte/icons/loader-2';
	import { cn } from "$lib/utils";
	import type { ComponentProps } from "svelte";

	let {
		class: className,
		role = "status",
		"aria-label": ariaLabel = "Loading",
		...restProps
	}: ComponentProps<typeof Loader2Icon> = $props();
</script>

<Loader2Icon {role} aria-label={ariaLabel} class={cn("size-4 animate-spin", className)} {...restProps} />
