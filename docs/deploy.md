# Deploying: Railway (backend) + Cloudflare Pages (frontend)

The repo's compose topology — nginx `least_conn` in front of two named API
nodes, Redis in between — maps onto Railway almost unchanged: Railway's
private network (`<service>.railway.internal`) stands in for compose's
service-name DNS, and its edge network supplies TLS for free. The static
`client/` map is a separate concern and lives on Cloudflare Pages instead,
talking to the Railway edge across origins.

This split is why `client/config.js` exists (points the map at the Railway
edge's public domain) and why `nginx/templates/default.conf.template` is
`envsubst`'d at container start rather than baked in — the same template
serves both docker-compose's service names and Railway's private-network
hostnames.

Platform CLIs and dashboard fields drift over time — treat the exact steps
below as of writing, and cross-check against Railway's/Cloudflare's current
docs if something doesn't match what you see.

## 1. Railway project

Create one Railway project with **five** services, all pointed at this
GitHub repo:

| service | source | build | start command | public networking | key env vars |
|---|---|---|---|---|---|
| `redis` | Railway's Redis template (not this repo) | — | — | no | provides `REDIS_URL` |
| `api-1` | this repo | root `Dockerfile` (default) | default (image `CMD`) | no | `NODE_ID=api-1`, `REDIS_URL=${{Redis.REDIS_URL}}` |
| `api-2` | this repo | root `Dockerfile` (default) | default | no | `NODE_ID=api-2`, `REDIS_URL=${{Redis.REDIS_URL}}` |
| `edge` | this repo | Dockerfile path → `Dockerfile.edge` | default | **yes**, target port `8080` | `UPSTREAM_API_1=api-1.railway.internal:3000`, `UPSTREAM_API_2=api-2.railway.internal:3000` |
| `simulator` | this repo | root `Dockerfile` (default) | override → `node dist/simulator/drive.js` | no | `WS_URL=ws://edge.railway.internal:8080/ws`, `DRIVERS=5`, `UPDATE_HZ=2` |

Notes:

- `${{Redis.REDIS_URL}}` is Railway's variable-reference syntax — set it once
  on `api-1`/`api-2` and it tracks the Redis service automatically.
- Only `edge` gets public networking; `api-1`, `api-2`, and `simulator` should
  stay private — nothing but `edge` and `simulator` needs to reach the API
  nodes, and both do so over `.railway.internal`.
- Generate the public domain on `edge` (Settings → Networking → Generate
  Domain), targeting port 8080. Railway terminates TLS on that domain for
  free — this is what makes `wss://` work with zero cert management.
- Once you have that domain, put it in [client/config.js](../client/config.js)
  (`window.API_BASE = 'your-edge-service.up.railway.app'`) and push — Pages
  redeploys the client automatically via CI.

### CI deploy (RAILWAY_TOKEN)

`deploy-railway` in [.github/workflows/ci.yml](../.github/workflows/ci.yml)
runs `railway up --service <name>` for all four app services after tests
pass on `main`. It needs a **Project Token** — Railway dashboard → this
project → Settings → Tokens → create one scoped to this project — saved as
the `RAILWAY_TOKEN` repo secret (Settings → Secrets and variables → Actions).
A project-scoped token lets `railway up --service X` target each service
directly, without a separate `railway link`.

## 2. Cloudflare Pages

Create a Pages project (dashboard, or `wrangler pages project create
realtime-tracking-demo`) — it doesn't need Cloudflare's own git integration
connected, since `deploy-cloudflare-pages` in ci.yml pushes to it directly via
`wrangler pages deploy client --project-name=realtime-tracking-demo` after
tests pass. If you rename the project, update that `--project-name` to match.

### CI deploy secrets

- `CLOUDFLARE_API_TOKEN` — a token with the "Cloudflare Pages: Edit"
  permission (My Profile → API Tokens → Create Token).
- `CLOUDFLARE_ACCOUNT_ID` — found on any domain's Overview page in the
  Cloudflare dashboard, or `wrangler whoami`.

Both go in the repo's Actions secrets alongside `RAILWAY_TOKEN`.

## 3. First deploy checklist

1. Create the Railway project and its 5 services per the table above.
2. Generate `edge`'s public domain; note it.
3. Create the Cloudflare Pages project.
4. Add `RAILWAY_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` as
   GitHub Actions secrets on this repo.
5. Put the `edge` domain into `client/config.js`, commit, push to `main`.
6. Watch the `deploy-railway` / `deploy-cloudflare-pages` jobs in the
   Actions tab; once green, the edge domain serves `/ws` and `/drivers`,
   and the Pages domain serves the map pointed at it.

## What's deliberately not solved here

- **Simulator sleep/idle policies** — some Railway plans idle services with
  no inbound HTTP traffic. `simulator` has none (it only makes outbound WS
  connections), so confirm it isn't reaped by an idle timeout on your plan.
- **Origin checks** — `/drivers` allows `Access-Control-Allow-Origin: *`
  since it's public, read-only, unauthenticated. `/ws` doesn't check the
  `Origin` header at all. Fine for a demo; a real deployment would restrict
  both to the known Pages domain.
- **A custom domain end-to-end** — both platforms support custom domains;
  wiring one up is a DNS step outside this repo, not a code change.
