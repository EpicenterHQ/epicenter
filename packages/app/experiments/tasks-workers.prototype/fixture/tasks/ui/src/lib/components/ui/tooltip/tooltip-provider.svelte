<script lang="ts">
	import { Tooltip as TooltipPrimitive } from "bits-ui";

	let { delayDuration = 300, skipDelayDuration = 150, ...restProps }: TooltipPrimitive.ProviderProps = $props();
</script>

<TooltipPrimitive.Provider {delayDuration} {skipDelayDuration} {...restProps} />
