<script lang="ts">
	import * as Collapsible from '@epicenter/ui/collapsible';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import type { Snippet } from 'svelte';

	// The settings "Advanced" disclosure: a quiet toggle that hides the secondary
	// fields the common path should skip. Owns the muted trigger, the chevron, and
	// its open-state rotation, so every settings surface renders the exact same
	// affordance from one place instead of restating the class stack.
	//
	// This composes the headless `@epicenter/ui` Collapsible by hand, which is the
	// shadcn-svelte pattern for a bespoke labeled disclosure: Collapsible ships
	// unstyled on purpose, and Accordion (which bakes in a chevron) is for a
	// coordinated set of sections, not a lone toggle. It stays app-local until a
	// second app grows the same idiom; the other collapsibles in the monorepo
	// (sidebar sections, search groups, tree folders) are different affordances.
	let { children, label = 'Advanced' }: { children: Snippet; label?: string } = $props();
</script>

<Collapsible.Root>
	<Collapsible.Trigger
		class="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-sm [&[data-state=open]>svg]:rotate-180"
	>
		<ChevronDownIcon class="size-4 transition-transform" />
		{label}
	</Collapsible.Trigger>
	<Collapsible.Content class="pt-3">
		{@render children()}
	</Collapsible.Content>
</Collapsible.Root>
