/**
 * Test helper: `$app/navigation` for views mounted outside a SvelteKit app.
 * Nothing navigates in jsdom, so a navigation hook is never called.
 */
export function beforeNavigate(
	_callback: (navigation: { cancel(): void }) => void,
) {}
