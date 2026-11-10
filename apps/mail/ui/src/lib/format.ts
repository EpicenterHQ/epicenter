/** Small presentation rules shared by the list and message pages. */
export function relativeTime(date: string, now = Date.now()) {
	const minutes = Math.max(0, Math.floor((now - Date.parse(date)) / 60_000));
	if (minutes === 0) return 'just now';
	if (minutes < 60)
		return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
	const days = Math.floor(hours / 24);
	return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}
export function showChip(id: string) {
	return id !== 'UNREAD' && id !== 'INBOX' && !id.startsWith('CATEGORY_');
}
