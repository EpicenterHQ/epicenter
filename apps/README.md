# apps

Only the hosted API is left here. It stays until Whispering 8 ships with no
sign-in ([ADR-0894](../docs/adr/0894-whispering-8-keeps-its-recordings-and-their-audio-in-its-own-data-directory-and-needs-no-epicenter.md)):
Whispering 7 signs in, transcribes, and is billed through it, and
`.github/workflows/deploy.cloudflare.yml` deploys it from here. Then it leaves
with the old product's packages, and this folder goes
([ADR-0891](../docs/adr/0891-this-repository-holds-the-runtime-and-programs-and-every-starter-is-a-repository-of-its-own.md)).

In Epicenter an app is a folder `epicenter` runs, and none lives in this
repository ([ADR-0877](../docs/adr/0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md)).
Programs are in [`programs/`](../programs/README.md) and the website in
[`sites/landing`](../sites/landing). Honeycrisp, Local Books, the PostHog
proxy, and the composition guide that described the frozen apps are at the
tag `before-0891-layout`.
