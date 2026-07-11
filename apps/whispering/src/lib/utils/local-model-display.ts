export function formatModelSize(bytes: number | null): string {
	if (!bytes) return '';
	const mb = bytes / 1_000_000;
	return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
