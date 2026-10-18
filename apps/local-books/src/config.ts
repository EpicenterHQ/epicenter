import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';
import { DEFAULT_ENTITIES, isKnownEntity } from './entities.ts';
import { booksDataDir, credentialsFilePath } from './paths.ts';

/**
 * Which QuickBooks deployment a company lives in. This schema is the single
 * source of truth: `QbEnvironment` derives from it, and both `ConfigFileSchema`
 * and `TokenSetSchema` reference it rather than re-spelling the literal union.
 */
export const QbEnvironmentSchema = Type.Union([
	Type.Literal('sandbox'),
	Type.Literal('production'),
]);
export type QbEnvironment = Static<typeof QbEnvironmentSchema>;

/**
 * Fully-resolved runtime configuration. Precedence is CLI flags > environment >
 * `<app-dir>/config.json` > built-in defaults. Base-URL fields are overridable
 * so tests can point the client at a mock QuickBooks server.
 */
export type AppConfig = {
	/**
	 * Local Books' one directory, `<epicenter-root>/apps/so.epicenter.local-books`. Not the
	 * Epicenter root above it: the app never sees that, and never computes an OS
	 * application-data path (ADR-0201).
	 */
	dataDir: string;
	environment: QbEnvironment;
	redirectUri: string;
	scopes: string[];
	entities: string[];
	/** QuickBooks data API origin, e.g. `https://sandbox-quickbooks.api.intuit.com`. */
	apiBase: string;
	/** OAuth2 token endpoint (authorization-code and refresh exchanges). */
	tokenUrl: string;
	/** OAuth2 authorization endpoint the browser is sent to. */
	authorizeUrl: string;
	minorVersion: string;
	/**
	 * Force a FULL pull once the stored cursor is older than this. Kept under the
	 * QuickBooks CDC 30-day lookback so incremental never silently loses a gap.
	 */
	cdcSafeWindowDays: number;
	/** Force a FULL pull this many days after the last one, as a correctness backstop. */
	fullBackstopDays: number;
	/** Query-API page size; QuickBooks caps results at 1000. */
	pageSize: number;
	/**
	 * Absolute path to the `0600` `credentials.json` holding the realm's OAuth
	 * tokens. Defaults to the app-directory root; override with `LOCAL_BOOKS_TOKEN_FILE`
	 * (used by the test harness and any custom location). See ADR-0062.
	 */
	credentialsPath: string;
	realmOverride: string | null;
	/**
	 * Port the localhost OAuth callback server binds to. Defaults to the port in
	 * `redirectUri`. Set it when `redirectUri` is a public HTTPS tunnel (no port),
	 * as Intuit production requires: the tunnel forwards to this local port.
	 */
	callbackPort: number | null;
	/**
	 * Reads only: the `query` and `report` verbs stay available, but `recategorize`
	 * (the one QuickBooks write) is refused. The safety posture for "analyze my
	 * books, do not mutate them", whether you run the verbs yourself or hand the
	 * mirror artifact to an agent. `LOCAL_BOOKS_READ_ONLY`.
	 */
	readOnly: boolean;
};

export type CliConfigOverrides = {
	environment?: QbEnvironment;
	realm?: string;
};

const API_BASE: Record<QbEnvironment, string> = {
	sandbox: 'https://sandbox-quickbooks.api.intuit.com',
	production: 'https://quickbooks.api.intuit.com',
};

const DEFAULT_TOKEN_URL =
	'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const DEFAULT_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const DEFAULT_REDIRECT_URI = 'http://localhost:8765/callback';
const DEFAULT_SCOPE = 'com.intuit.quickbooks.accounting';
const DEFAULT_MINOR_VERSION = '70';

const ConfigFileSchema = Type.Object({
	environment: Type.Optional(QbEnvironmentSchema),
	entities: Type.Optional(Type.Array(Type.String())),
	redirectUri: Type.Optional(Type.String({ minLength: 1 })),
	scopes: Type.Optional(Type.Array(Type.String())),
	minorVersion: Type.Optional(Type.String({ minLength: 1 })),
	cdcSafeWindowDays: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	fullBackstopDays: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	pageSize: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	callbackPort: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	readOnly: Type.Optional(Type.Boolean()),
});
type ConfigFile = Static<typeof ConfigFileSchema>;

/**
 * `<app-dir>/config.json`, or nothing when there is no such file. A file that
 * is there is read whole or refused with what does not read: dropping it for
 * defaults would silently undo a setting such as `readOnly`.
 */
function readConfigFile(dataDir: string): ConfigFile {
	const path = join(dataDir, 'config.json');
	let source: string;
	try {
		source = readFileSync(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch (error) {
		throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
	}
	if (Value.Check(ConfigFileSchema, parsed)) return parsed;
	const problems = Value.Errors(ConfigFileSchema, parsed).map(
		(problem) => `${problem.instancePath || '/'} ${problem.message}`,
	);
	throw new Error(`${path}: ${problems.join('; ')}`);
}

function env(name: string): string | undefined {
	const value = process.env[name];
	return value && value.length > 0 ? value : undefined;
}

/** A boolean env flag: present and not `0`/`false` is true; absent is undefined. */
function envFlag(name: string): boolean | undefined {
	const value = env(name);
	if (value === undefined) return undefined;
	return value !== '0' && value.toLowerCase() !== 'false';
}

function resolveEntities(file: ConfigFile): string[] {
	const fromEnv = env('LOCAL_BOOKS_ENTITIES')
		?.split(',')
		.map((s) => s.trim());
	const requested = fromEnv ?? file.entities ?? DEFAULT_ENTITIES;
	const unknown = requested.filter((name) => !isKnownEntity(name));
	if (unknown.length > 0) {
		throw new Error(
			`Unknown entities in config: ${unknown.join(', ')}. Known: ${DEFAULT_ENTITIES.join(', ')}.`,
		);
	}
	return requested;
}

export function loadConfig(overrides: CliConfigOverrides = {}): AppConfig {
	const dataDir = booksDataDir();
	const file = readConfigFile(dataDir);
	const callbackPortEnv = env('LOCAL_BOOKS_CALLBACK_PORT');

	const environment: QbEnvironment =
		overrides.environment ??
		(env('LOCAL_BOOKS_QB_ENV') as QbEnvironment | undefined) ??
		file.environment ??
		'sandbox';

	return {
		dataDir,
		environment,
		// The Intuit app keys are NOT read here: they are resolved lazily at the
		// OAuth/refresh site by their environment-qualified names (ADR-0108), so a
		// credential-free verb (`query`, `status`) never touches them. See
		// `resolveQbCredentials` in qb-credentials.ts.
		redirectUri:
			env('LOCAL_BOOKS_QB_REDIRECT_URI') ??
			file.redirectUri ??
			DEFAULT_REDIRECT_URI,
		scopes: file.scopes ?? [DEFAULT_SCOPE],
		entities: resolveEntities(file),
		apiBase: env('LOCAL_BOOKS_QB_API_BASE') ?? API_BASE[environment],
		tokenUrl: env('LOCAL_BOOKS_QB_TOKEN_URL') ?? DEFAULT_TOKEN_URL,
		authorizeUrl: env('LOCAL_BOOKS_QB_AUTHORIZE_URL') ?? DEFAULT_AUTHORIZE_URL,
		minorVersion:
			env('LOCAL_BOOKS_QB_MINOR_VERSION') ??
			file.minorVersion ??
			DEFAULT_MINOR_VERSION,
		cdcSafeWindowDays: file.cdcSafeWindowDays ?? 25,
		fullBackstopDays: file.fullBackstopDays ?? 7,
		pageSize: Math.min(file.pageSize ?? 1000, 1000),
		credentialsPath:
			env('LOCAL_BOOKS_TOKEN_FILE') ?? credentialsFilePath(dataDir),
		realmOverride: overrides.realm ?? env('LOCAL_BOOKS_QB_REALM') ?? null,
		callbackPort: callbackPortEnv
			? Number(callbackPortEnv)
			: (file.callbackPort ?? null),
		readOnly: envFlag('LOCAL_BOOKS_READ_ONLY') ?? file.readOnly ?? false,
	};
}
