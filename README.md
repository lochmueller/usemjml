# mjml-server

A small, fast HTTP API around [MJML](https://mjml.io): render templates to HTML,
validate them, and ask which MJML version is running — optionally protected with
HTTP Basic Auth, configured entirely through environment variables.

- **Fast**: [Fastify](https://fastify.dev) on Node 24, no framework overhead.
- **Slim**: ~167 MB image — Alpine plus the bare `node` binary, no npm, no MJML CLI.
- **Safe by default**: runs as a non-root user, `mj-include` is disabled, and
  client-supplied options can never touch the file system.
- **Drop-in**: `POST /` behaves like other `mjml-server` images.

```bash
docker run -p 8080:8080 \
  -e BASIC_AUTH_USER=mjml \
  -e BASIC_AUTH_PASSWORD=change-me \
  ghcr.io/lochmueller/mjml-server:latest
```

```bash
curl -u mjml:change-me -H 'Content-Type: text/plain' \
  --data-binary '<mjml><mj-body><mj-section><mj-column><mj-text>Hello</mj-text></mj-column></mj-section></mj-body></mjml>' \
  http://localhost:8080/render
```

## API

| Method | Path        | Purpose                                   | Auth |
| ------ | ----------- | ----------------------------------------- | ---- |
| `POST` | `/render`   | Render MJML to HTML                       | yes  |
| `POST` | `/`         | Alias of `/render` (drop-in compatibility) | yes  |
| `POST` | `/validate` | Validate MJML, always answers with JSON    | yes  |
| `GET`  | `/version`  | MJML, server and Node version             | yes  |
| `GET`  | `/health`   | Liveness probe                            | no*  |

<sub>*unless `BASIC_AUTH_PROTECT_HEALTH=true`.</sub>

### Request body

Both endpoints that take MJML accept two shapes:

**Raw** — any of `text/plain`, `text/mjml`, `text/x-mjml`, `application/mjml`,
`text/html`, `text/xml`, `application/xml`:

```bash
curl -H 'Content-Type: text/plain' --data-binary @mail.mjml http://localhost:8080/render
```

**JSON** — `application/json`, with per-request options:

```json
{
  "mjml": "<mjml>…</mjml>",
  "config": {
    "validationLevel": "strict",
    "minify": true,
    "beautify": false,
    "keepComments": true,
    "fonts": { "Inter": "https://fonts.example/inter.css" }
  }
}
```

`config` and `options` are interchangeable, as are `mjml`, `template` and
`content` for the template itself. Anything not listed above is rejected with
`422` — that includes `filePath`, `includePath` and `mjmlConfigPath`, which stay
under server control on purpose.

The same options also work as query parameters, which is handy for raw bodies:

```bash
curl -H 'Content-Type: text/plain' --data-binary @mail.mjml \
  'http://localhost:8080/render?minify=true&validationLevel=strict'
```

### Response

`/render` answers with `text/html` by default and adds an `X-MJML-Errors` header
with the number of soft validation errors. Ask for JSON with
`Accept: application/json`, with `?format=json`, or globally with
`RESPONSE_FORMAT=json`:

```json
{
  "html": "<!doctype html>…",
  "errors": [{ "line": 1, "message": "…", "tagName": "mj-text" }],
  "mjml": "5.4.1"
}
```

`/validate` always answers with JSON and status `200` — an invalid template is a
valid answer, not an error:

```json
{
  "valid": false,
  "errors": [
    {
      "line": 1,
      "message": "mj-text cannot be used inside mj-body, only inside: mj-attributes, mj-column, mj-hero",
      "tagName": "mj-text"
    }
  ],
  "validationLevel": "soft",
  "mjml": "5.4.1"
}
```

The validation level can be given per request, either as a query parameter or in
the JSON body, and the response echoes the level that was applied:

```bash
curl -u mjml:change-me -H 'Content-Type: text/plain' --data-binary @mail.mjml \
  'http://localhost:8080/validate?validationLevel=strict'
```

```bash
curl -u mjml:change-me -H 'Content-Type: application/json' \
  -d '{"mjml":"<mjml>…</mjml>","config":{"validationLevel":"strict"}}' \
  http://localhost:8080/validate
```

MJML runs the same rule set on `soft` and `strict`, so both report the same
errors — the level only decides when it gives up:

| Level              | What happens                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `soft` *(default)* | Validates and then renders. The most thorough level: it also catches failures that only show up while rendering.            |
| `strict`           | Same rules, but MJML aborts as soon as the validator finds something, so an invalid template is never rendered. A valid one is rendered just like with `soft`. |
| `skip`             | No validation at all — only reports templates that cannot be parsed or rendered.                                            |

`/validate` defaults to `soft` and deliberately ignores `MJML_VALIDATION_LEVEL`:
that variable is the default for rendering, and a server configured with
`skip` would otherwise call every template valid. Unknown levels are rejected
with `422`.

`/version`:

```json
{ "mjml": "5.4.1", "server": "mjml-server", "node": "24.21.0" }
```

### Status codes

| Code  | When                                                                 |
| ----- | -------------------------------------------------------------------- |
| `200` | Rendered or validated                                                 |
| `401` | Basic Auth enabled and credentials missing or wrong                   |
| `404` | Unknown route (the body lists the available ones)                     |
| `413` | Body larger than `MAX_BODY_SIZE`                                      |
| `415` | Unsupported `Content-Type`                                            |
| `422` | Empty body, unknown option, or a template that fails `strict` validation |
| `500` | Unexpected failure — details go to the log, not to the client          |

## Basic Auth

Authentication is off until credentials are configured; setting any account
turns it on for every route except `/health`.

```bash
docker run -p 8080:8080 \
  -e BASIC_AUTH_USER=mjml \
  -e BASIC_AUTH_PASSWORD='a long random secret' \
  ghcr.io/lochmueller/mjml-server:latest
```

For several accounts use `BASIC_AUTH_USERS`, a comma separated list of
`user:password` pairs. Only the first colon separates, so passwords may contain
colons themselves:

```bash
-e BASIC_AUTH_USERS='ci:token-one,newsletter:token:two'
```

Details worth knowing:

- Passwords are compared in constant time (SHA-256 digest + `timingSafeEqual`),
  and an unknown user costs the same as a wrong password.
- Failed attempts are logged at `warn` level with the client IP. Set
  `TRUST_PROXY=true` when running behind a reverse proxy so that IP is the real
  one from `X-Forwarded-For`.
- Basic Auth sends credentials base64-encoded, not encrypted — terminate TLS in
  front of this container.
- `/health` stays open so orchestrators can probe it; flip
  `BASIC_AUTH_PROTECT_HEALTH=true` if you would rather not.

## Configuration

All settings are environment variables. Invalid values stop the container at
startup with exit code `78` and a message naming the variable.

### Server

| Variable          | Default   | Description                                                      |
| ----------------- | --------- | ---------------------------------------------------------------- |
| `PORT`            | `8080`    | Listening port                                                    |
| `HOST`            | `0.0.0.0` | Bind address                                                      |
| `MAX_BODY_SIZE`   | `2097152` | Maximum request body in bytes (2 MiB)                             |
| `LOG_LEVEL`       | `info`    | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`      |
| `REQUEST_LOGGING` | `false`   | Log every request, not just failures                              |
| `TRUST_PROXY`     | `false`   | Honour `X-Forwarded-*` headers                                    |
| `CORS`            | *(off)*   | `*` or a comma separated list of allowed origins                  |

### Authentication

| Variable                     | Default       | Description                                  |
| ---------------------------- | ------------- | -------------------------------------------- |
| `BASIC_AUTH_USER`            | *(unset)*     | Single account, together with the password    |
| `BASIC_AUTH_PASSWORD`        | *(unset)*     | Single account, together with the user        |
| `BASIC_AUTH_USERS`           | *(unset)*     | `user:pass,other:pass` for several accounts   |
| `BASIC_AUTH_REALM`           | `mjml-server` | Realm shown in the browser prompt             |
| `BASIC_AUTH_PROTECT_HEALTH`  | `false`       | Require auth for `/health` as well            |

### MJML

| Variable                | Default                    | Description                                          |
| ----------------------- | -------------------------- | ---------------------------------------------------- |
| `MJML_VALIDATION_LEVEL` | `soft`                     | Default for `/render`: `skip`, `soft` (report) or `strict` (fail with `422`). `/validate` always defaults to `soft`. |
| `MJML_MINIFY`           | `false`                    | Minify the generated HTML                             |
| `MJML_BEAUTIFY`         | `false`                    | Pretty-print the generated HTML                       |
| `MJML_KEEP_COMMENTS`    | `true`                     | Keep HTML comments                                    |
| `MJML_FONTS`            | MJML defaults              | JSON object of font name → stylesheet URL             |
| `MJML_INCLUDES`         | `false`                    | Allow `<mj-include>`                                  |
| `MJML_INCLUDE_DIR`      | `/var/lib/mjml/includes`   | Directory `<mj-include>` may read from                |

### Response

| Variable                | Default                    | Description                                    |
| ----------------------- | -------------------------- | ---------------------------------------------- |
| `RESPONSE_FORMAT`       | `html`                     | Default body of `/render`: `html` or `json`     |
| `RESPONSE_CONTENT_TYPE` | `text/html; charset=utf-8` | `Content-Type` used for HTML responses          |

Booleans accept `1/true/yes/on` and `0/false/no/off`.

## Using `mj-include`

File includes are disabled by default, so no request can make the server read
from disk. To enable them, mount your partials read-only into the include
directory and switch them on:

```bash
docker run -p 8080:8080 \
  -v "$PWD/partials:/var/lib/mjml/includes:ro" \
  -e MJML_INCLUDES=true \
  ghcr.io/lochmueller/mjml-server:latest
```

```html
<mj-include path="./header.mjml" />
```

MJML 5 itself confines includes to that directory: absolute paths, UNC paths and
`../` escapes are replaced with `<!-- mj-include denied -->`.

## Docker Compose

See [compose.yaml](compose.yaml) — it runs the container read-only, without
capabilities and with `no-new-privileges`, and reads the credentials from `.env`
(copy [.env.example](.env.example)).

```bash
cp .env.example .env
docker compose up -d
```

## Publishing to the GitHub Container Registry

Two workflows are included:

- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the unit tests,
  builds the image and smoke-tests the running container on every push and pull
  request.
- [`.github/workflows/publish.yml`](.github/workflows/publish.yml) builds
  `linux/amd64` and `linux/arm64` and pushes to
  `ghcr.io/lochmueller/mjml-server` on every push to `main`, on every `v*.*.*`
  tag, and manually via *Run workflow*. The image name is derived from
  `github.repository`, so a fork or a rename needs no change.

Tags produced by the publish workflow:

| Trigger              | Tags                                                  |
| -------------------- | ----------------------------------------------------- |
| Push to `main`       | `latest`, `main`, `sha-<short>`, `mjml-<mjml version>` |
| Tag `1.2.3`         | `1.2.3`, `1.2`, `1`, `sha-<short>`                     |
| Push to other branch | `<branch>`, `sha-<short>`                              |

No secrets to configure: the workflow authenticates with the built-in
`GITHUB_TOKEN`. It also attaches an SBOM, SLSA provenance and a signed build
attestation, so consumers can verify the image:

```bash
gh attestation verify oci://ghcr.io/lochmueller/mjml-server:latest --owner lochmueller
```

The package is private on first push. Make it public under
*Repository → Packages → Package settings → Change visibility*.

If you keep this project in a subdirectory of a larger repository, set
`context:` in both workflows (and `working-directory` for the npm steps) to that
subdirectory.

## Development

```bash
npm install
npm run dev     # restarts on change
npm test        # node:test, no test framework needed
```

```bash
docker build -t mjml-server .
docker run --rm -p 8080:8080 mjml-server
```

## Performance

Measured inside the container on a 10-core machine, with a realistic newsletter
template (10 sections, 6.4 KB of MJML), default settings:

| | |
| ------------------------------ | ---------------------------------------------- |
| HTTP, auth and body parsing    | ~0.2 ms                                         |
| MJML rendering                 | ~4 ms (0.7 ms for a one-section mail, 15 ms for 25 KB) |
| Throughput                     | ~250 rps, flat from concurrency 4 upwards       |
| Latency                        | p50 3.9 ms / p99 6.9 ms at concurrency 1, p99 117 ms at concurrency 16 |
| Cold start                     | ~240 ms until listening, first render ~29 ms, then ~4 ms |

The HTTP layer accounts for roughly 5 % of a request — rendering is everything
else. MJML renders CPU-bound and synchronously, so **one container saturates one
core**: every request blocks the event loop for the duration of the render and
concurrent requests queue behind it. That is why throughput stops growing at
concurrency 4 while latency keeps rising.

### Scaling

Run one container per core you want to use — behind a load balancer, or as
replicas in Kubernetes with `cpu: 1` per pod. That is the simplest way to use a
whole machine and keeps each container at the ~150 MB it needs.

Running several workers inside one container (`node:cluster`) reaches the same
goal: a prototype with 8 workers measured ~1250 rps instead of ~250, with p99 at
concurrency 16 dropping from 117 ms to 36 ms, at the cost of ~150 MB per worker.
It is deliberately not built in — if you add it, size the pool from
`/sys/fs/cgroup/cpu.max` rather than `os.availableParallelism()`, which reports
the host's cores inside a container and over-forks under a CPU limit, and give
each worker a `--max-old-space-size` so the heaps do not each grow into the
container's whole memory limit.

Two smaller knobs, both measured but not enabled here: rendering one throwaway
template before `listen()` moves the ~25 ms of JIT warm-up off the first real
request, and `NODE_COMPILE_CACHE` cuts startup from ~240 ms to ~190 ms (it needs
a writable directory, so it conflicts with the read-only container in
[compose.yaml](compose.yaml) unless you point it at a tmpfs).

### Benchmarking

The image ships a `node` binary, so it can load-test itself without any extra
tooling — replace `mjml` with your container name and `mail.mjml` with a
template that resembles your real ones:

```bash
docker exec -e CONCURRENCY=8 -e DURATION=5 mjml node --input-type=module -e '
import { readFileSync } from "node:fs";
const body = readFileSync("/tmp/mail.mjml", "utf8");
const url = `http://127.0.0.1:${process.env.PORT || 8080}/render`;
const until = Date.now() + Number(process.env.DURATION) * 1000;
const lat = [];
const run = async () => {
  while (Date.now() < until) {
    const t = performance.now();
    await fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body }).then((r) => r.text());
    lat.push(performance.now() - t);
  }
};
const started = performance.now();
await Promise.all(Array.from({ length: Number(process.env.CONCURRENCY) }, run));
lat.sort((a, b) => a - b);
console.log(`${(lat.length / ((performance.now() - started) / 1000)).toFixed(0)} rps  p50 ${lat[lat.length >> 1].toFixed(1)}ms  p99 ${lat[Math.floor(lat.length * 0.99)].toFixed(1)}ms`);
'
```

Copy the template in first with `docker cp mail.mjml mjml:/tmp/mail.mjml`, and
add an `authorization` header to the `fetch` call if Basic Auth is on.

Measuring from inside the container is not a detail: on macOS, Docker Desktop's
port forwarding adds ~16 ms to every POST, which showed 50 rps through the
published port where the same server did 242 rps internally. On Linux the
published port is fine.

## How it stays small

- The runtime image is plain `alpine` with the `node` binary copied in from
  `node:24-alpine` — npm, corepack and their ~18 MB never reach the final layer.
- Dependencies are `mjml-core`, `mjml-preset-core` and `mjml-validator` instead
  of the `mjml` umbrella package. That package adds nothing but the same three
  lines of wiring (see [src/mjml.js](src/mjml.js)) plus the CLI with `chokidar`,
  `yargs` and `glob`, none of which a server needs.
- `npm ci --omit=dev` runs in a build stage; only `node_modules` is copied over,
  minus markdown, source maps and test fixtures.

## License

[MIT](LICENSE). MJML itself is MIT licensed by Mailjet.
