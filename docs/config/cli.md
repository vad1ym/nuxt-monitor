# CLI

```bash
npx monitor <command>
```

Deliberately small. Anything the dashboard can answer belongs in the dashboard,
where it has context; the one thing it cannot do is hash a password you have
not set yet.

## hash-password

```bash
npx monitor hash-password
# Password: ••••••••
# scrypt$16384$8$1$B9LU0+9UzkVAs/…$J8oKz1KAr0H1tHRFsAEz…
```

Prints a scrypt hash for `monitor.auth.passwordHash`, so the plaintext never has
to appear in your config or your build output.

Reads from a prompt when no password is given, which keeps it out of your shell
history and out of the process list. The hash goes to stdout and nothing else,
so it can be piped:

```bash
npx monitor hash-password > .hash
```

You can pass it directly when a prompt is not available — in a provisioning
script, say — accepting that it will be visible to anything that can read the
process list:

```bash
npx monitor hash-password "$PASSWORD"
```

### The format

```
scrypt$16384$8$1$<salt base64>$<derived key base64>
```

The parameters are carried in the hash itself, so one made today stays
verifiable if the defaults change later. Verification is constant-time.
