<script lang="ts">
	import { cn } from '@epicenter/ui/utils';
	import { page } from '$app/state';
	import { getLibrary } from '$lib/library.svelte.js';
	import { navItems, pageAt } from './nav-items.js';

	const library = getLibrary();
</script>

<!-- The pages on a narrow window. It sits in the shell's column, so nothing is hidden behind it. -->
<nav class="flex h-14 shrink-0 items-center gap-1 border-t border-sidebar-border bg-sidebar px-1" aria-label="Pages">
	{#each navItems(library.view) as item (item.href)}
		{@const active = item.page === pageAt(page.url.pathname)}
		{@const Icon = item.icon}
		<a
			href={item.href}
			aria-current={active ? 'page' : undefined}
			class={cn(
				'flex flex-1 flex-col items-center gap-0.5 rounded-md py-1.5 text-xs outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring',
				active
					? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
					: 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
			)}
		>
			<Icon class="size-5" />
			<span>{item.label}</span>
		</a>
	{/each}
</nav>
