<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { buttonVariants } from '@epicenter/ui/button';
</script>

<nav aria-label="Notes" class="flex gap-1">
	<a
		href={resolve('/personal')}
		aria-current={page.url.pathname === resolve('/personal') ? 'page' : undefined}
		class={buttonVariants({
			size: 'sm',
			variant: page.url.pathname === resolve('/personal') ? 'secondary' : 'ghost',
		})}
	>Personal</a>
	<a
		href={resolve('/local')}
		aria-current={page.url.pathname === resolve('/local') ? 'page' : undefined}
		class={buttonVariants({
			size: 'sm',
			variant: page.url.pathname === resolve('/local') ? 'secondary' : 'ghost',
		})}
	>Local</a>
</nav>
