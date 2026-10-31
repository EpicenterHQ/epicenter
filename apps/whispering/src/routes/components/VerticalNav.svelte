<script lang="ts">
	import * as Sidebar from '@epicenter/ui/sidebar';
	import { useSidebar } from '@epicenter/ui/sidebar';
	import { page } from '$app/state';
	import studioMicrophone from '$lib/assets/studio-microphone.png';
	import { getLibrary } from '$lib/library.svelte.js';
	import { navItems, pageAt } from './nav-items.js';

	const sidebar = useSidebar();
	const library = getLibrary();
</script>

<Sidebar.Root collapsible="icon">
	<Sidebar.Header>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton size="lg" aria-label="Whispering: {sidebar.open ? 'collapse' : 'expand'} the sidebar" onclick={sidebar.toggle}>
					<div class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent">
						<img src={studioMicrophone} alt="" class="size-4" />
					</div>
					<div class="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
						<span class="truncate font-semibold">Whispering</span>
						<span class="truncate text-xs text-muted-foreground">Speech to text</span>
					</div>
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupContent>
				<Sidebar.Menu aria-label="Pages">
					{#each navItems(library.view) as item (item.href)}
						{@const active = item.page === pageAt(page.url.pathname)}
						<Sidebar.MenuItem>
							<Sidebar.MenuButton isActive={active} tooltipContent={item.label}>
								{#snippet child({ props })}
									{@const Icon = item.icon}
									<a href={item.href} aria-current={active ? 'page' : undefined} {...props}>
										<Icon />
										<span>{item.label}</span>
									</a>
								{/snippet}
							</Sidebar.MenuButton>
						</Sidebar.MenuItem>
					{/each}
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>
	</Sidebar.Content>

	<Sidebar.Rail />
</Sidebar.Root>
