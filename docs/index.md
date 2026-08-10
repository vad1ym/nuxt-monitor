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
    details: Browser, OS, device, release, route, session — what the occurrences have in common.
  - title: Redacted on the way in
    details: Authorization headers, cookies, passwords and tokens never reach the database.
  - title: Never the reason you are down
    details: Writes are batched off the request path. If the database cannot be opened, collection stops and the app keeps serving.
---

![The overview: error rate, errors over time, the biggest contributor, and routes ranked by failure rate](/media/overview.png)
