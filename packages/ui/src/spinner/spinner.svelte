<script lang="ts">
	import Loader2Icon from "@lucide/svelte/icons/loader-2";
	import { cn } from "../utils.js";
	import type { ComponentProps } from "svelte";

	// Epicenter: app loading controls use this icon; the registry's app-local placeholder is unavailable here.
	let {
		class: className,
		role = "status",
		"aria-label": ariaLabel = "Loading",
		...restProps
	}: ComponentProps<typeof Loader2Icon> = $props();
</script>

<Loader2Icon
	{role}
	aria-label={ariaLabel}
	class={cn("size-4 animate-spin", className)}
	{...restProps}
/>
