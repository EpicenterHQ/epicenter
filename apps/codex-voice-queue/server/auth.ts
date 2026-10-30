import { createHash, timingSafeEqual } from 'node:crypto';

export function createAuth({
	token,
	now = Date.now,
}: {
	token: string;
	now?: () => number;
}) {
	const digest = createHash('sha256').update(token).digest();
	const failures = new Map<string, { count: number; startedAt: number }>();
	const windowMs = 10 * 60 * 1000;
	return {
		check(request: Request, clientKey: string): 200 | 401 | 429 {
			const at = now();
			for (const [key, entry] of failures)
				if (at - entry.startedAt >= windowMs) failures.delete(key);
			const failed = failures.get(clientKey);
			if (failed && failed.count >= 20) return 429;
			const authorization = request.headers.get('authorization');
			const supplied = authorization?.startsWith('Bearer ')
				? authorization.slice(7)
				: '';
			if (
				supplied &&
				timingSafeEqual(digest, createHash('sha256').update(supplied).digest())
			)
				return 200;
			failures.set(clientKey, {
				count: (failed?.count ?? 0) + 1,
				startedAt: failed?.startedAt ?? at,
			});
			return 401;
		},
	};
}
