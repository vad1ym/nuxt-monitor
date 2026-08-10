# Authentication

The dashboard shows stack traces, source excerpts and request headers from
your production application. It has to be protected, and the module refuses to
guess on your behalf: with no credentials configured, every dashboard route
answers `404`.

## Setting a password

The convenient form, fine in development:

```ts
monitor: {
  auth: {
    username: 'admin',
    password: process.env.MONITOR_PASSWORD,
  },
}
```

The better form for production, where the plaintext never appears in your
config or your build output:

```bash
npx monitor hash-password
# Password: ••••••••
# scrypt$16384$8$1$B9LU0+9UzkVAs/…$J8oKz1KAr0H1tHRFsAEz…
```

```ts
monitor: {
  auth: { passwordHash: process.env.MONITOR_PASSWORD_HASH },
}
```

`passwordHash` wins over `password` when both are present. Reading from a
prompt rather than `argv` keeps the password out of your shell history and out
of the process list.

## Setting it at runtime instead

`NUXT_MONITOR_AUTH_PASSWORD` is read when the server starts rather than when it
is built. That is what you want when one build is deployed to several
environments, or when the password is a secret your platform injects.

```bash
NUXT_MONITOR_AUTH_PASSWORD=… node .output/server/index.mjs
```

The build warns once if it finds no password, since forgetting entirely is the
common mistake. It does not bake the decision in: an install that supplies the
password at start-up is perfectly ordinary, and refusing it at build time would
lock those deployments out with no way to recover.

## How the session works

Signing in sets a cookie that is:

- **`httpOnly`**, so no script on the page can read it;
- **`Secure`** outside development, so it is never sent over plain HTTP;
- **`SameSite=Lax`**, so it does not ride along on cross-site requests;
- **scoped to the dashboard route**, so it is never attached to your own
  application's requests;
- **signed**, with an expiry inside the payload — a forged or edited cookie
  fails verification rather than being trusted.

`sessionTtl` controls how long it lasts (7 days by default).

### Changing the password logs everyone out

The signing secret is derived from the password when you do not set one
explicitly, so changing the password invalidates every outstanding session —
which is the behaviour you want from a password change.

Set `auth.secret` yourself if you need sessions to survive a password change,
or if you run more than one instance and want a session to work across them.

::: tip This was a real bug
The secret used to be derived from the *stored hash*, which is salted
randomly. A new salt is generated on every boot, so every restart silently
invalidated all sessions. If you ever configured `auth.secret` to work around
mysterious logouts, you can remove it.
:::

## Cross-origin requests

Requests that change something — resolving an issue, signing out — must come
from the dashboard's own origin. `SameSite=Lax` already blocks the ordinary
cross-site form post, but it does not cover a sibling subdomain: on a host
with wildcard DNS, `evil.internal.example.com` is same-site with
`monitor.internal.example.com` and the browser will attach the cookie.

Signing in is deliberately exempt. It acts on nobody's behalf, and requiring
an `Origin` header would break every non-browser client.
