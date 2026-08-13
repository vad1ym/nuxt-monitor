---
layout: home

hero:
  name: nuxt-monitor
  text: Error monitoring that stays on your machine
  tagline: No DSN, no account, no sourcemap upload.
  image:
    src: /logo.png
    alt: nuxt-monitor
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Configuration
      link: /config/

features:
  - title: Server and client
    details: One Nitro hook catches every server path; a browser plugin catches the rest, including after hydration.
  - title: Traces resolved to source
    details: The failing line in context. Maps are read from disk, never served to the public.
  - title: Grouped into issues
    details: By side, type, normalised message and the first frame in your own code.
  - title: Broken down
    details: Browser, OS, device, release, route, session — what the occurrences have in common, measured against real traffic.
  - title: The bodies, not just the stack
    details: What came back, and what was sent if you ask for it. A stack says where the code broke; a body says what broke it.
  - title: Redacted on the way in
    details: Authorization headers, cookies, passwords and tokens never reach the database.
  - title: Never the reason you are down
    details: Writes are batched off the request path. If the database cannot be opened, collection stops and the app keeps serving.
---

![The overview: requests and failure rate, errors drawn against traffic, the biggest contributor, the busiest endpoints, and errors per page view by browser](/media/overview.png)
