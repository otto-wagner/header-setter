# header-setter-proxy

Local proxy that routes a host to a different target without changing the `Host`
header or the TLS server name.

## Why a proxy is needed

Chrome does not let an extension set the `Host` header or read the TLS SNI, so
a host cannot be redirected at the request level. What an extension _can_ do is
decide **where the connection goes**: it installs a PAC script that sends only
the mapped hosts to `127.0.0.1:8899`, and this proxy opens the TCP connection to
the real target instead.

```
Chrome ──CONNECT staging.httpbin.org:443──▶ header-setter-proxy ──TCP──▶ httpbin.org:443
   │                                                   │
   └── TLS handshake and HTTP request ─────────────────┴──── relayed byte for byte ───▶
       (SNI and Host stay "staging.httpbin.org")
```

## Install

macOS or Linux via Homebrew:

```sh
brew tap otto-wagner/header-setter https://github.com/otto-wagner/header-setter
brew install header-setter-proxy
```

Windows via Scoop:

```sh
scoop bucket add header-setter https://github.com/otto-wagner/header-setter
scoop install header-setter-proxy
```

Or grab a binary from the [releases page](https://github.com/otto-wagner/header-setter/releases),
or build it from this directory:

```sh
make build        # writes build/header-setter-proxy
```

## Run

```sh
header-setter-proxy serve
header-setter-proxy serve staging.httpbin.org=httpbin.org
header-setter-proxy serve --log-level debug staging.httpbin.org=httpbin.org qa.httpbin.org=httpbin.org:8443
```

Routes given as `host=target` arguments are the starting table; the extension's
pushes to the admin API **replace** it entirely and win as soon as the popup is
opened. A target may carry its own port (`host=target:8443`); without one the
port the client asked for is kept.

Stop with `Ctrl+C`. `SIGINT`/`SIGTERM` stop accepting connections, close open
tunnels and exit with status 0.

## Which host pairs work

Only `https://` is tunneled (via CONNECT); the browser validates the target's
certificate against the source host, so a pair only works when both are
covered by the same certificate (usually a wildcard) and the target actually
serves that host. `httpbin.org` satisfies both and is a self-verifying
example:

```sh
header-setter-proxy serve staging.httpbin.org=httpbin.org
curl --proxy 127.0.0.1:8899 https://staging.httpbin.org/headers
```

```json
{
  "headers": {
    "Host": "staging.httpbin.org",
    ...
  }
}
```

The response proves all three parts: the certificate was accepted, the
connection went to `httpbin.org`, and `Host` still says `staging.httpbin.org`.
Note `staging.httpbin.org` does not need to exist in DNS — only the proxy
resolves the target.

If the certificate doesn't cover the source host, the browser aborts with
`ERR_CERT_COMMON_NAME_INVALID` before sending anything; only a pair covered by
the same certificate works.

## Flags

| Flag           | Default          | Purpose                                    |
|----------------|------------------|--------------------------------------------|
| `--proxy-addr` | `127.0.0.1:8899` | Loopback address the proxy listens on.     |
| `--admin-addr` | `127.0.0.1:8900` | Loopback address the admin API listens on. |
| `--log-level`  | `info`           | `debug`, `info`, `warn` or `error`.        |

Both addresses must be loopback: the admin API authenticates callers only by
browser origin, which says nothing about the machine they run on.

Connection timeouts are fixed and not configurable: 10s to read the first
request, 10s to connect upstream, 5m of inactivity before closing an
established connection.


## Admin API

Bound to `127.0.0.1:8900`. `api.http` in this directory has ready-to-run
requests. A call from an extension page needs a
[Private Network Access](https://developer.chrome.com/blog/private-network-access-preflight)
preflight answer; without it Chrome shows `TypeError: Failed to fetch`.

| Request        | Effect                                                            |
|----------------|-------------------------------------------------------------------|
| `GET /routes`  | Returns the current table as a `{"from": "to"}` object.           |
| `POST /routes` | Replaces the whole table with the posted `{"from": "to"}` object. |
| `GET /health`  | Returns `{"status":"ok","routes":N,"failures":{...}}`.            |

