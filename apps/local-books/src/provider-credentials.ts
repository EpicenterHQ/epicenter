/**
 * Third-party provider credential resolution (ADR-0105).
 *
 * The mechanism only: one pure resolver plus the `ProviderCredentialSpec` type
 * and an `.env.example` formatter. Each multi-environment app owns its own
 * `spec` (`QB_SPEC` in local-books); there is no central provider
 * registry here, so no package accretes knowledge of every app's providers.
 *
 * A provider credential is selected by exactly one knob, the app's target
 * provider-environment, and that selection rides on the secret's *name*, never
 * on which vault environment happened to inject it. The name is the one thing
 * every secret backend (Infisical, a `.env` file, Docker secrets, systemd,
 * Kubernetes, Wrangler bindings) projects identically into the flat
 * `name -> value` map this resolver reads through the injected `read` source.
 *
 * AGPL, pure-TS, zero runtime deps, so it is safe inside `bun build --compile`
 * and can be imported by the AGPL apps. It is never imported by an MIT toolkit
 * package: toolkits take injected credentials, they do not resolve them.
 */

/** A credential slot a provider needs. Free-form so `PLAID_SECRET` etc. fit. */
export type CredentialRole = string;

/**
 * One provider's credential contract. `environments` is the provider-environment
 * axis (NOT the vault env): the external accounts this provider can talk to.
 *
 * Roles split into two kinds because providers differ honestly:
 *  - `sharedRoles`      value is the same across accounts -> `${PREFIX}_${ROLE}`
 *                       (Plaid's client_id: one id, a secret per environment)
 *  - `environmentRoles` value differs per account -> `${PREFIX}_${ENV}_${ROLE}`
 *                       (QB: a whole distinct OAuth client per account)
 */
export type ProviderCredentialSpec<
	Env extends string = string,
	Role extends CredentialRole = CredentialRole,
> = {
	/** UPPER_SNAKE provider prefix: 'QB', 'GMAIL', 'PLAID'. */
	prefix: string;
	/** The provider-environment literals, e.g. ['sandbox', 'production']. */
	environments: readonly Env[];
	/** Roles whose value is invariant across environments. Default: none. */
	sharedRoles?: readonly Role[];
	/** Roles whose value differs per environment. */
	environmentRoles: readonly Role[];
};

/** Where names are read from. Injected so the deploy axis is one seam. */
export type CredentialSource = (name: string) => string | undefined;

const fromProcessEnv: CredentialSource = (name) => process.env[name];

export class ProviderCredentialError extends Error {}

/**
 * The whole naming convention. A role is environment-qualified only when it is
 * an `environmentRole` AND the provider has more than one environment; otherwise
 * (a shared role, or a single-environment provider) the env segment is dropped.
 */
function credentialEnvName(
	spec: ProviderCredentialSpec,
	environment: string,
	role: string,
): string {
	const qualify =
		spec.environments.length > 1 && spec.environmentRoles.includes(role);
	return qualify
		? `${spec.prefix}_${environment.toUpperCase()}_${role}`
		: `${spec.prefix}_${role}`;
}

/**
 * Resolve one provider's credentials for a target environment. Returns a record
 * keyed by role (shared + environment roles), or throws a message naming the
 * exact missing qualified vars. Pure: the only I/O is the injected `read`.
 */
export function resolveProviderCredentials<
	Env extends string,
	Role extends CredentialRole,
>(
	spec: ProviderCredentialSpec<Env, Role>,
	environment: Env,
	read: CredentialSource = fromProcessEnv,
): Record<Role, string> {
	// No `*_ENVIRONMENT` vault tag: a wrong VALUE under a right NAME is caught by
	// the token-environment assertion at the app's token store (mint env must
	// equal use env), not by a parallel secret that GIGO makes illusory.
	const roles = [...(spec.sharedRoles ?? []), ...spec.environmentRoles];
	const out = {} as Record<Role, string>;
	const missing: string[] = [];
	for (const role of roles) {
		const name = credentialEnvName(spec, environment, role);
		const value = read(name);
		if (value === undefined || value.length === 0) missing.push(name);
		else out[role] = value;
	}
	if (missing.length > 0) {
		throw new ProviderCredentialError(
			`Missing ${spec.prefix} ${environment} credentials: ${missing.join(', ')}. ` +
				`Names are environment-qualified where the value differs per account; ` +
				`check the Infisical path (or Wrangler secrets) you injected from.`,
		);
	}
	return out;
}

/**
 * Render a provider's canonical qualified names as `.env.example` lines, with
 * empty values, grouped by shared roles then by environment. Built from the same
 * `credentialEnvName` the resolver reads through, so a generated `.env.example`
 * cannot drift from what `resolveProviderCredentials` will look for. Callers
 * concatenate one provider's block per app (join with a blank line).
 */
export function specToEnvExampleLines(spec: ProviderCredentialSpec): string[] {
	const lines: string[] = [
		`# ${spec.prefix} (set only the environments you run)`,
	];
	const sharedRoles = spec.sharedRoles ?? [];
	if (sharedRoles.length > 0) {
		lines.push(`# shared across every ${spec.prefix} environment`);
		for (const role of sharedRoles) {
			lines.push(`${spec.prefix}_${role}=`);
		}
	}
	if (spec.environmentRoles.length > 0) {
		for (const environment of spec.environments) {
			lines.push(`# ${environment}`);
			for (const role of spec.environmentRoles) {
				lines.push(`${credentialEnvName(spec, environment, role)}=`);
			}
		}
	}
	return lines;
}
