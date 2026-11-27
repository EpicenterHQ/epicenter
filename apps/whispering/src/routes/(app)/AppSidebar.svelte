<!--
	Whispering's three places: Home, Recordings, and Settings, which lists
	its own sections. Settings carries a mark while dictation still needs
	something set there; Home says what.
-->
<script lang="ts">
	import * as Sidebar from '@epicenter/ui/sidebar';
	import FlaskConicalIcon from '@lucide/svelte/icons/flask-conical';
	import HouseIcon from '@lucide/svelte/icons/house';
	import ListIcon from '@lucide/svelte/icons/list';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import { page } from '$app/state';
	import studioMicrophone from '#lib/assets/studio-microphone.png';
	import { getDictation } from '#lib/dictation-view.ts';

	const dictation = getDictation();

	const PLACES = [
		{ label: 'Home', href: '/', icon: HouseIcon },
		{ label: 'Recordings', href: '/recordings', icon: ListIcon },
		{ label: 'Settings', href: '/settings', icon: SettingsIcon },
		// The preview page has no address bar to reach it from in the desktop app.
		...(import.meta.env.DEV ? [{ label: 'Preview', href: '/preview', icon: FlaskConicalIcon }] : []),
	];

	const unmet = $derived(dictation.needs().length > 0);
</script>

<Sidebar.Root collapsible="icon">
	<Sidebar.Header>
		<Sidebar.Menu>
			<Sidebar.MenuItem>
				<Sidebar.MenuButton size="lg" tooltipContent="Whispering">
					{#snippet child({ props })}
						<a href="/" {...props}>
							<img src={studioMicrophone} alt="" class="size-8 shrink-0 drop-shadow" />
							<span class="truncate text-base font-semibold">Whispering</span>
						</a>
					{/snippet}
				</Sidebar.MenuButton>
			</Sidebar.MenuItem>
		</Sidebar.Menu>
	</Sidebar.Header>

	<Sidebar.Content>
		<Sidebar.Group>
			<Sidebar.GroupContent>
				<Sidebar.Menu aria-label="Pages">
					{#each PLACES as item (item.href)}
						{@const active =
							item.href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(item.href)}
						<Sidebar.MenuItem>
							<Sidebar.MenuButton isActive={active} tooltipContent={item.label}>
								{#snippet child({ props })}
									<a href={item.href} aria-current={active ? 'page' : undefined} {...props}>
										<item.icon />
										<span>{item.label}</span>
									</a>
								{/snippet}
							</Sidebar.MenuButton>
							{#if item.href === '/settings' && unmet}
								<Sidebar.MenuBadge class="text-destructive">
									<span aria-hidden="true">!</span>
									<span class="sr-only">Needs attention</span>
								</Sidebar.MenuBadge>
							{/if}
						</Sidebar.MenuItem>
					{/each}
				</Sidebar.Menu>
			</Sidebar.GroupContent>
		</Sidebar.Group>
	</Sidebar.Content>

	<Sidebar.Rail />
</Sidebar.Root>
