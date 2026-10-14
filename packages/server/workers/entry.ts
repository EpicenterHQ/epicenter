/**
 * Test-only: the Worker the `vitest` pool needs as its entry. The tests here
 * build their own Hono apps, so this one answers nothing.
 */
export default { fetch: () => new Response(null, { status: 404 }) };
