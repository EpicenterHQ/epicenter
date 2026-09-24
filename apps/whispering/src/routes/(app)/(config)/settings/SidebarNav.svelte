<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { cn } from '@epicenter/ui/utils';
	import { cubicInOut } from 'svelte/easing';
	import { crossfade } from 'svelte/transition';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';

	const items = [
		{ title: 'General', href: resolve('/settings') },
		{ title: 'Recording', href: resolve('/settings/recording') },
		{
			title: 'Privacy & Processing',
			href: resolve('/settings/processing'),
		},
		{ title: 'Dictation', href: resolve('/settings/dictation') },
		{
			title: 'Shortcuts',
			href: resolve('/settings/shortcuts'),
			activePathPrefix: resolve('/settings/shortcuts'),
		},
		{ title: 'Sound', href: resolve('/settings/sound') },
		{ title: 'Analytics', href: resolve('/settings/analytics') },
		{ title: 'Account', href: resolve('/settings/account') },
	] satisfies {
		title: string;
		href: string;
		/**
		 * If provided, the item is considered active if the current pathname starts with this prefix.
		 * Otherwise, it is considered active if the current pathname is exactly equal to the item's href.
		 */
		activePathPrefix?: string;
	}[];

	const [send, receive] = crossfade({
		duration: 250,
		easing: cubicInOut,
	});
</script>

<nav
	class="flex gap-2 overflow-auto lg:flex-col lg:gap-1"
	aria-label="Settings navigation"
>
	{#each items as item (item.href)}
		{@const isActive = item.activePathPrefix
			? page.url.pathname.startsWith(item.activePathPrefix)
			: page.url.pathname === item.href}

		<Button
			href={item.href}
			variant="ghost"
			class={cn(
				'relative justify-start text-left font-normal transition-colors',
				isActive
					? 'text-sidebar-accent-foreground hover:bg-sidebar-accent/50'
					: 'text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground',
			)}
			aria-current={isActive ? 'page' : undefined}
			data-sveltekit-noscroll
		>
			{#if isActive}
				<div
					class="bg-sidebar-accent absolute inset-0 rounded-md"
					in:send={{ key: 'active-sidebar-tab' }}
					out:receive={{ key: 'active-sidebar-tab' }}
				></div>
			{/if}
			<span class="relative z-10"> {item.title} </span>
		</Button>
	{/each}
</nav>
