# Domain operations

Cloudflare stores and runs the DNS, security settings, and redirect rules.
Operators change them in the Cloudflare dashboard. The repository has a
read-only audit, not a provisioner or an apply command.

## Audit

From the repository root:

```sh
bun run cf:audit:remote
```

The command reads the 13 domains declared in `cf/audit.ts`. It checks the
Always Use HTTPS and Automatic HTTPS Rewrites settings, strict origin TLS,
a minimum TLS version of 1.2 or higher, and Cloudflare's DNSSEC status.
It reports HSTS settings without
asserting one policy for every subdomain. It reads public SPF and DMARC records
through the system DNS resolver, joining TXT chunks before checking duplicates.
Domains declared as having no mail use must have SPF `v=spf1 -all` and DMARC
`p=reject`. External mail domains are observed for duplicate records; their
provider configuration is not validated. `epicenter.software` has no declared
mail policy yet. Public SPF records on `epicenter.sh` conflict with its former
no-mail classification. Both domains need mail-policy review, so their records
are observations only apart from duplicate checks.

Exit 0 means these selected checks passed. Exit 1 means an issue or incomplete
read needs review. It does not certify all zone settings, HSTS eligibility,
mail delivery, redirect behavior, or the DNSSEC chain. Nothing schedules it.
Run it when commissioning a domain or after changing domain settings.

Infisical's production `/ops` path supplies `CLOUDFLARE_ZONE_TOKEN`. The audit
needs only `Zone:Read`, `Zone Settings:Read`, and `DNS:Read` for the declared zones. Retiring
the writer does not change the existing token's permissions; those must be
reduced separately. Public DNS reads need no Cloudflare token.

## Shared baseline and exceptions

Keep HTTPS enabled, use strict TLS for origin connections, and require TLS 1.2
or higher. A new zone needs an explicit entry and mail classification in
`cf/audit.ts`; the inventory does not discover or claim ownership of every zone
in the account. Keep `epicenter.audio` listed while its registration is active.

HSTS is a hostname commitment. Review HTTPS support on every affected subdomain
before enabling `includeSubDomains`. An HSTS change is an observation in this
audit, so review that output even when the selected checks pass. The former
writer's 180-day, subdomain-wide HSTS configuration is not applied automatically.
See [Cloudflare's HSTS requirements](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/http-strict-transport-security/).

For DNSSEC, inspect the registrar's DS record and validate the public chain.
Cloudflare's reported status is recorded separately from that verification.
Pending status needs investigation, not another blind enable request. Compare
the DS value Cloudflare reports with the registrar and public DNS:

```sh
dig +short DS epicenter.so
dig +short DS epicenter.md
```

Web redirects do not imply that a domain has no email. Preserve provider-managed
mail configuration on `epicenter.so`, `epicenter.md`, and `getepicenter.com`.
Do not add a no-mail SPF policy to those domains. A single SPF record is required;
duplicate records need a deliberate provider-specific repair.

## Redirects

[ADR 0472](../docs/adr/0472-epicenter-so-is-canonical-and-product-domains-need-a-distinct-identity.md)
records the three product aliases. [Whispering redirects](../docs/guides/whispering-redirects.md)
records the legacy domains. Configure rules on the source zone and ensure each
source hostname has proxied DNS. Verify root and `www` over HTTP and HTTPS
after a change, including a non-root path and query string.

On October 1, 2026, the 12 zones in the former writer matched its five web
settings. `epicenter.so` and `epicenter.md` reported DNSSEC pending and no DS was
returned by the public resolver. Public DNS returned two SPF records for
`getepicenter.com`, despite the former API-based plan reporting its SPF as clean.
Those are unresolved operational findings, not changes made by this retirement.

The replacement audit completed all 13 zones and reported these additional
findings: duplicate public SPF on `epicenter.sh`; no public SPF or DMARC on
`epicenter.build`; and `epicenter.software` with Always Use HTTPS off, origin
TLS mode `full`, minimum TLS 1.0, and DNSSEC disabled. Review settings against
each domain's use before changing them. Origin TLS mode does not secure a
redirect that Cloudflare serves without contacting an origin.
