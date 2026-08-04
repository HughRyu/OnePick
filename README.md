# OnePick

OnePick is a self-hosted media parsing and download service with a browser UI, userscript integration, and iOS Shortcuts support.

## Docker Compose

```bash
cp .env.example .env
# Edit .env before starting the service.
docker compose up -d --build
```

The default web endpoint is `http://localhost:3877`.

Runtime state and credentials are stored under `data/`, `cookies/`, and `.env`; these paths are excluded from Git.

## Container image

GitHub Actions publishes a multi-architecture image for `linux/amd64` and `linux/arm64`:

```bash
docker pull ghcr.io/hughryu/onepick:latest
```

## Tests

```bash
npm ci
npm test
npm audit --omit=dev --audit-level=high
```

See [docs-parsers.md](docs-parsers.md) for parser architecture notes.