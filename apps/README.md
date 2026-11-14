# apps

Only the hosted API is left here, and it stays: it is a service, live and
paid, that Whispering 7 signs in, transcribes, and is billed through. It moves
to `services/api` in its own change, and then this folder is gone
([ADR-0891](../docs/adr/0891-this-repository-holds-the-runtime-and-programs-and-every-starter-is-a-repository-of-its-own.md)).
Until then `.github/workflows/deploy.cloudflare.yml` deploys it from here.

An app is a folder in an Epicenter, and none lives in this repository
([ADR-0877](../docs/adr/0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md)).
Programs are in [`programs/`](../programs/README.md) and the website in
[`sites/landing`](../sites/landing). Honeycrisp, Local Books, the PostHog
proxy, and the composition guide that described the frozen apps are at the
tag `before-0891-layout`.
