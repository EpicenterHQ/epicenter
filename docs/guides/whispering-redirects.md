# Whispering Redirects

Whispering now lives in `EpicenterHQ/epicenter`:

- Source: `https://github.com/EpicenterHQ/epicenter/tree/main/apps/whispering`
- Downloads: `https://github.com/EpicenterHQ/epicenter/releases/latest`
- Web app: `https://whispering.epicenter.so`
- Product page: `https://epicenter.so/whispering`

Keep `braden-w/whispering` archived. It preserves old issues, stars, forks, and release links, but its README should stay pointed at the current source and release locations. GitHub repository redirects are useful for renamed or transferred repositories, but they do not redirect cleanly to a subdirectory inside a monorepo.

## Redirect Targets

Use permanent redirects for old public domains:

| Old URL | Target |
| --- | --- |
| `https://getwhispering.com/*` | `https://epicenter.so/whispering` |
| `https://www.getwhispering.com/*` | `https://epicenter.so/whispering` |
| `https://whispering.studio/*` | `https://epicenter.so/whispering` |
| `https://www.whispering.studio/*` | `https://epicenter.so/whispering` |
| `https://whispering.bradenwong.com/*` | `https://epicenter.so/whispering` |
| `https://whispering.epicenterhq.com/*` | `https://whispering.epicenter.so` |

Use the product page for old marketing/download links. Use the web app only when the old URL was already an app URL.

## Cloudflare Setup

Cloudflare stores and runs these redirects. Change them in the dashboard.
The former repository apply command has been retired; [domain operations](../../ops/README.md)
documents the shared security baseline and read-only `bun run cf:audit:remote`
command. The audit does not check or provision redirect rules.

In Cloudflare, configure redirects on the zone that receives the old traffic, not on the destination zone.

For each old zone:

1. Make sure the hostname has a proxied DNS record. Redirect Rules only run after the request reaches Cloudflare's proxy.
2. Go to `Rules` -> `Redirect Rules`.
3. Create a rule matching the old hostnames.
4. Set status code `301`.
5. Set the target URL to `https://epicenter.so/whispering` or `https://whispering.epicenter.so`.
6. Keep query strings only if they carry useful campaign data. Otherwise drop them.

For `getwhispering.com`, one expression can cover both apex and `www`:

```txt
(http.host eq "getwhispering.com" or http.host eq "www.getwhispering.com")
```

For `whispering.studio`:

```txt
(http.host eq "whispering.studio" or http.host eq "www.whispering.studio")
```

For old subdomains like `whispering.bradenwong.com` and `whispering.epicenterhq.com`, add redirect rules in the parent zones (`bradenwong.com` and `epicenterhq.com`). If those zones are not in this Cloudflare account, configure the same 301 at their DNS/hosting provider instead.

## Verification

After changing Cloudflare, check each old URL:

```bash
curl -I https://getwhispering.com
curl -I https://www.getwhispering.com
curl -I https://whispering.studio
curl -I https://www.whispering.studio
curl -I https://whispering.bradenwong.com
curl -I https://whispering.epicenterhq.com
```

Each response should be `301` with a `Location` header pointing at the expected Epicenter URL.

On October 1, 2026, `getwhispering.com` and `whispering.studio`, including
their `www` hosts, returned 301 to `https://epicenter.so/whispering` over both
HTTP and HTTPS. A request to `/about?retirement_check=1` also returned that
fixed destination, discarding the source path and query. These legacy rules
differ from the product aliases in ADR 0472, which retain paths and queries.
