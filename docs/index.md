---
layout: home

hero:
  name: nuxt-monitor
  text: Error monitoring that stays on your machine
  tagline: No DSN, no account, no sourcemap upload. It runs inside your app and reads maps off the disk they were built onto.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Configuration
      link: /config/

features:
  - title: Both sides, one hook
    details: A single Nitro error hook catches every server path — handlers, plugins, cached functions, unhandled rejections — and a client plugin catches what happens in the browser, including after hydration.
  - title: Stack traces resolved to source
    details: The failing line and the lines around it. Maps are read from disk beside the running app, so they cannot drift out of sync with the build that produced the error, and they are never served to the public.
  - title: Occurrences grouped into issues
    details: By side, type, normalised message and the first frame in your own code — so a message carrying an id does not become a thousand separate issues.
  - title: Broken down by what they share
    details: Browser, OS, device, release, route, session. "250 errors" is a number; "250 errors, all Safari 16" is a diagnosis.
  - title: Redacted on the way in
    details: Authorization headers, cookies, passwords and tokens never reach the database. Scrubbing on read would leave them on disk.
  - title: Never the reason you are down
    details: Writes are buffered and batched, so an error storm puts no I/O on a request path. If the database cannot be opened at all, collection turns itself off and the app keeps serving.
---
