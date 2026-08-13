# Changelog


## v0.1.4

[compare changes](https://github.com/vad1ym/nuxt-monitor/compare/v0.1.3...v0.1.4)

### 🚀 Enhancements

- **notify:** Alerts to Telegram and webhooks, with the rules that keep them wanted ([90f8ad7](https://github.com/vad1ym/nuxt-monitor/commit/90f8ad7))
- **dashboard:** A notifications screen, and credentials that stay out of the build ([907cde9](https://github.com/vad1ym/nuxt-monitor/commit/907cde9))
- **exception:** Report what does not throw, and route it by group ([ea857c6](https://github.com/vad1ym/nuxt-monitor/commit/ea857c6))
- **sampling:** Stop writing the fiftieth copy, keep the count exact ([6654783](https://github.com/vad1ym/nuxt-monitor/commit/6654783))
- Export and CLI, and endpoints told apart from pages ([1bb19ad](https://github.com/vad1ym/nuxt-monitor/commit/1bb19ad))
- **groups:** Name parts of the app by rule, and watch the ones that matter ([6e9138e](https://github.com/vad1ym/nuxt-monitor/commit/6e9138e))
- **traffic:** Judge a breakdown against the audience, not against other errors ([a4a16e3](https://github.com/vad1ym/nuxt-monitor/commit/a4a16e3))
- **uptime:** Tell a quiet night from a dead process ([1f23a58](https://github.com/vad1ym/nuxt-monitor/commit/1f23a58))
- **stats:** A statistics screen, with uptime as a row of calm days inside it ([8564097](https://github.com/vad1ym/nuxt-monitor/commit/8564097))
- **overview:** One dashboard, where every count carries its denominator ([f4e0dd3](https://github.com/vad1ym/nuxt-monitor/commit/f4e0dd3))
- **overview:** One tabbed table where traffic and errors sit in the same row ([ac30c4d](https://github.com/vad1ym/nuxt-monitor/commit/ac30c4d))
- **issues:** Filter by group ([6d979f6](https://github.com/vad1ym/nuxt-monitor/commit/6d979f6))

### 🩹 Fixes

- **proxy:** Stop dropping every browser error behind a reverse proxy ([4f0b087](https://github.com/vad1ym/nuxt-monitor/commit/4f0b087))
- **overview:** Rings that say what they are, and the incident above the fold ([05aab13](https://github.com/vad1ym/nuxt-monitor/commit/05aab13))

### 🎨 Styles

- **overview:** Pair the two short lists into one row ([2bdc1ba](https://github.com/vad1ym/nuxt-monitor/commit/2bdc1ba))
- **filters:** Scopes on one row, facets on the next ([252ff46](https://github.com/vad1ym/nuxt-monitor/commit/252ff46))
- **shell:** Pin the sidebar, scroll only the content ([1067c0e](https://github.com/vad1ym/nuxt-monitor/commit/1067c0e))
- **issues:** Kind and status in one badge, labels aligned right ([b9411c4](https://github.com/vad1ym/nuxt-monitor/commit/b9411c4))
- **issues:** The request as one badge, method to status ([bd70c92](https://github.com/vad1ym/nuxt-monitor/commit/bd70c92))

### ❤️ Contributors

- Vadym Bulakh ([@vad1ym](https://github.com/vad1ym))

## v0.1.3

[compare changes](https://github.com/vad1ym/nuxt-monitor/compare/v0.1.2...v0.1.3)

### 🚀 Enhancements

- **dashboard:** Real charts on echarts, spaced windows, wider seed ([6f11e4d](https://github.com/vad1ym/nuxt-monitor/commit/6f11e4d))
- **dashboard:** Name the source file, and stop cutting facets silently ([6612e6d](https://github.com/vad1ym/nuxt-monitor/commit/6612e6d))
- **dashboard:** Occurrences over time, and the rate beside the count ([43969c5](https://github.com/vad1ym/nuxt-monitor/commit/43969c5))

### ❤️ Contributors

- Vadym Bulakh ([@vad1ym](https://github.com/vad1ym))

## v0.1.2

[compare changes](https://github.com/vad1ym/nuxt-monitor/compare/v0.1.1...v0.1.2)

### 🚀 Enhancements

- **dashboard:** Ignore, sort, paging, new badge, and a real traffic screen ([49a24ec](https://github.com/vad1ym/nuxt-monitor/commit/49a24ec))

### 🩹 Fixes

- Stop counting assets, spread the seed over time, name versions ([de160ba](https://github.com/vad1ym/nuxt-monitor/commit/de160ba))

### 💅 Refactors

- **dashboard:** Three screens, one window, state in the URL ([0d93887](https://github.com/vad1ym/nuxt-monitor/commit/0d93887))

### ✅ Tests

- Fill the buffer in two flushes instead of 1200 ([7a66709](https://github.com/vad1ym/nuxt-monitor/commit/7a66709))

### 🎨 Styles

- **dashboard:** Name the package in full in the wordmark ([7fa1ed3](https://github.com/vad1ym/nuxt-monitor/commit/7fa1ed3))

### ❤️ Contributors

- Vadym Bulakh ([@vad1ym](https://github.com/vad1ym))

## v0.1.1

[compare changes](https://github.com/vad1ym/nuxt-monitor/compare/v0.1.0...v0.1.1)

### 🚀 Enhancements

- Serve the dashboard without a password in dev ([579b19a](https://github.com/vad1ym/nuxt-monitor/commit/579b19a))
- Support PostgreSQL and MySQL ([a57b879](https://github.com/vad1ym/nuxt-monitor/commit/a57b879))

### 🩹 Fixes

- Confine untrusted sourcemap source reads to the map's directory ([f60916a](https://github.com/vad1ym/nuxt-monitor/commit/f60916a))
- Await store reads in dashboard routes, and queue counters before open ([0b9ed77](https://github.com/vad1ym/nuxt-monitor/commit/0b9ed77))

### 💅 Refactors

- Add a db0 connection seam ([69834d9](https://github.com/vad1ym/nuxt-monitor/commit/69834d9))
- Move the storage layer onto db0 and make it async ([287b98f](https://github.com/vad1ym/nuxt-monitor/commit/287b98f))

### 📖 Documentation

- Trim the README and spread the screenshots through the guide ([a7edb8b](https://github.com/vad1ym/nuxt-monitor/commit/a7edb8b))
- Trim the prose and merge three thin pages ([fd6411c](https://github.com/vad1ym/nuxt-monitor/commit/fd6411c))
- Add the logo to the hero, the nav bar and the favicon ([dd7f19e](https://github.com/vad1ym/nuxt-monitor/commit/dd7f19e))

### 🤖 CI

- Publish the docs to GitHub Pages ([0910a05](https://github.com/vad1ym/nuxt-monitor/commit/0910a05))
- Drop needless quotes in the docs workflow ([92dba32](https://github.com/vad1ym/nuxt-monitor/commit/92dba32))

### ❤️ Contributors

- Vadym Bulakh ([@vad1ym](https://github.com/vad1ym))

