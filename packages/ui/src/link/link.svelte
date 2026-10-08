<!--
	Installed from @ieedan/shadcn-svelte-extras
-->

<script lang="ts" module>
	import type { HTMLAnchorAttributes } from 'svelte/elements';

	export type LinkProps = HTMLAnchorAttributes & {
		/**
		 * Tooltip text to display on hover.
		 * Requires a parent `<Tooltip.Provider>` in the component tree.
		 * Wrap your app root with `<Tooltip.Provider>` to enable tooltip coordination.
		 */
		tooltip?: string;
	};
</script>

<script lang="ts">
	import { mergeProps } from 'bits-ui';
	import * as Tooltip from '../tooltip/index.js';
	import { cn } from '../utils.js';

	let { children, class: className, tooltip, href, role, tabindex, type, ...rest }: LinkProps = $props();
</script>

{#snippet linkContent(tooltipProps?: Record<string, unknown>)}
	<a
		{...mergeProps(rest, tooltipProps ?? {})}
		{href}
		{role}
		{tabindex}
		{type}
		class={cn('text-primary underline-offset-4 hover:underline', className)}
	>
		{@render children?.()}
	</a>
{/snippet}

<!--
	When using the tooltip prop, this component requires a parent Tooltip.Provider.
	Wrap your app root with <Tooltip.Provider> to enable tooltip coordination.
-->
{#if tooltip}
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				{@render linkContent(props)}
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content class="max-w-xs text-center"> {tooltip} </Tooltip.Content>
	</Tooltip.Root>
{:else}
	{@render linkContent()}
{/if}
