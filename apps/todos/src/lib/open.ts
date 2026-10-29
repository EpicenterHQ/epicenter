/**
 * Open this browser's Todos repository: the replica of `todos` here, or a
 * new one the first time. With a server it syncs as `account`, whom the
 * development server takes from `Authorization: Bearer <account>`.
 */
import { createBrowserRepository, openBrowserRepository } from '@epicenter/repository/api/browser';
import { listReplicas } from '@epicenter/repository/hosts/browser';
import { Ok } from 'wellcrafted/result';
import { todosApp } from './definition.js';

export async function openTodos({ server, account }: { server: string | undefined; account: string }) {
	const headers: Record<string, string> = server === undefined ? {} : { authorization: `Bearer ${account}` };
	const found = (await listReplicas()).find((manifest) => manifest.repository === 'todos');
	if (found !== undefined) return Ok(openBrowserRepository({ app: todosApp, replica: found.replica, headers }));
	const created = await createBrowserRepository({ app: todosApp, repository: 'todos', name: 'Todos', account: server === undefined ? null : account, url: server ?? null, headers });
	if (created.error !== null) return created;
	return Ok(created.data.repository);
}
