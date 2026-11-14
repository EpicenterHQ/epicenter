# programs

A program is software that runs on its own and writes files an app's
collections declare, in its own folder
([ADR-0889](../docs/adr/0889-an-app-runs-on-epicenter-a-program-works-with-it-and-they-meet-at-the-apps-contract.md)).
Nothing here is an app: an app is a folder `epicenter` runs, and each lives in
a repository of its own
([ADR-0891](../docs/adr/0891-this-repository-holds-the-runtime-and-programs-and-every-starter-is-a-repository-of-its-own.md)).

| Program | What it does |
| --- | --- |
| [Whispering](whispering/README.md) | Records, transcribes, and pastes on the desktop and in a browser tab. |

Whispering still runs on the folder sync product's packages and the hosted
API; Whispering 8 drops both
([ADR-0894](../docs/adr/0894-whispering-8-keeps-its-recordings-and-their-audio-in-its-own-data-directory-and-needs-no-epicenter.md)).
