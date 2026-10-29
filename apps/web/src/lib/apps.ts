/**
 * The first-party apps, and the one lens the shell opens every repository
 * with. Each app is a lens: it claims files by path (`defineApp`), and any
 * of them opens any repository. The shell opens a repository once, with all
 * of their claims together, so moving between apps of one repository keeps
 * its handle; `defineApp` refuses two apps whose templates could claim one
 * file, and `combine` two apps that use one collection name.
 */
import { type App, type Definitions, defineApp, type Repository } from '@epicenter/repository';
import { honeycrispApp } from '@epicenter/honeycrisp';
import HoneycrispApp from '@epicenter/honeycrisp/app';
import { todosApp } from '@epicenter/todos';
import TodosApp from '@epicenter/todos/app';
import type { Component } from 'svelte';

/** What the shell gives an app's root: the open repository, its name and server, and the repository's page. */
export type RootProps<TDefs extends Definitions> = {
	repo: Repository<TDefs>;
	/** The repository's name in this browser. */
	repository: string;
	/** The server it syncs with, if any. */
	syncsTo?: string;
	/** The repository's page: its apps, and this browser's other repositories. */
	repositoryHref: string;
};

/** A first-party app: its address segment, its name, its lens, and its root. */
type FirstPartyApp<TDefs extends Definitions> = { id: string; name: string; app: App<TDefs>; Root: Component<RootProps<TDefs>> };

const firstParty = <TDefs extends Definitions>(entry: FirstPartyApp<TDefs>) => entry;

export const apps = [
	firstParty({ id: 'todos', name: 'Todos', app: todosApp, Root: TodosApp }),
	firstParty({ id: 'honeycrisp', name: 'Honeycrisp', app: honeycrispApp, Root: HoneycrispApp }),
] as const;

type Lensed = { id: string; app: { definitions: Definitions } };
type Intersected<T> = (T extends unknown ? (value: T) => void : never) extends (value: infer I) => void ? I : never;
/** Every app's definitions, intersected. */
type Merged<TApps extends readonly Lensed[]> = Intersected<TApps[number]['app']['definitions']>;

/** Every app's definitions as one app; throws when two apps name a collection alike. */
function combine<TApps extends readonly Lensed[]>(entries: TApps) {
	const merged: Definitions = {};
	const owners = new Map<string, string>();
	for (const { id, app } of entries)
		for (const [name, definition] of Object.entries(app.definitions)) {
			const other = owners.get(name);
			if (other !== undefined) throw new Error(`The apps '${other}' and '${id}' both name a collection '${name}'`);
			owners.set(name, id);
			merged[name] = definition;
		}
	return defineApp(merged as Merged<TApps> extends infer TDefs extends Definitions ? TDefs : never);
}

/** The lens every repository opens with: every first-party app's claims. */
export const lens = combine(apps);

/** The repository the shell opens: every first-party app's collections. */
export type ShellRepository = Repository<(typeof lens)['definitions']>;

export type AppId = (typeof apps)[number]['id'];

/** The first-party app with the address segment `id`, if there is one. */
export const appById = (id: string) => apps.find((entry) => entry.id === id);
