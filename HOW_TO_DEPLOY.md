# How to deploy your own `receipts`

This is a fully static page that talks straight to OpenAI from the user's browser. No server, no build step, no environment variables baked into the site. The only piece of hosted infrastructure is the page itself, plus a tiny Pages Function for privacy-respecting edge analytics.

Deployment below targets **Cloudflare Pages**. Anything else that serves static files will also work (Netlify, GitHub Pages, an nginx droplet) — in that case skip the analytics section, or roll your own with server access logs.

---

## One-time setup

### 1. Fork the repo

```bash
git clone https://github.com/<you>/receipts.git
cd receipts
```

### 2. Create a Pages project

Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**:

- Repository: `<you>/receipts`
- Project name: anything, e.g. `receipts`
- Framework preset: **None**
- Build command: *(leave empty)*
- Build output directory: `/`
- Production branch: `main`

Hit **Save and Deploy**. First build takes ~30 s. You get a preview URL like `receipts-xyz.pages.dev`.

### 3. Add the Analytics Engine binding (optional but recommended)

Your Pages project → **Settings → Functions → Bindings → Add → Analytics Engine**:

- Variable name: `HITS`
- Dataset name: `receipts_hits` (or anything — remember it for `stats.sh`)

Redeploy once (empty commit or "Retry deployment") so the function picks up the new binding.

### 4. Custom domain (optional)

Your Pages project → **Settings → Custom domains → Set up a custom domain** → enter your subdomain (e.g. `receipts.example.com`). Cloudflare auto-creates the CNAME if the zone is on Cloudflare.

---

## Updating the site

After the initial setup, **updates are just `git push`**. Cloudflare detects the push and redeploys in ~30 seconds. That's it.

If you want a pre-flight wrapper that runs `node --check` on the JS files first:

```bash
./scripts/deploy.sh
```

---

## Viewing traffic stats

Set the following once (keep this file out of the repo — `~/.receipts.env` is a good spot):

```bash
export CF_ACCOUNT_ID="<your account id>"
export CF_API_TOKEN="<token with 'Account Analytics: Read' permission>"
export RECEIPTS_DATASET="receipts_hits"     # the dataset name from step 3
export RECEIPTS_DOMAIN="receipts.example.com"
```

Then:

```bash
source ~/.receipts.env
./scripts/stats.sh        # last 7 days
./scripts/stats.sh 30     # last 30 days
```

You can also run ad-hoc SQL in the dashboard: **Workers & Pages → Analytics Engine → SQL** (or the account-level analytics page depending on UI).

Sample queries you'll want:

```sql
-- hits per day
SELECT toDate(timestamp) AS day, count() AS hits
FROM receipts_hits
WHERE index1 = 'receipts.example.com'
  AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY day ORDER BY day;

-- top referers
SELECT blob3 AS ref, count() AS hits
FROM receipts_hits
WHERE index1 = 'receipts.example.com'
  AND blob3 != ''
  AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY ref ORDER BY hits DESC LIMIT 20;

-- split by OS family (mac vs ios vs android vs bot vs other)
SELECT blob4 AS ua, count() AS hits
FROM receipts_hits
WHERE index1 = 'receipts.example.com'
  AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY ua ORDER BY hits DESC;
```

### What gets logged

Per request, one row:

| field | value |
| --- | --- |
| `index1` | hostname (`receipts.example.com`) — lets one dataset serve multiple subdomains |
| `blob1` | URL path |
| `blob2` | country code, derived at the CF edge from the request (no raw IP stored) |
| `blob3` | referer hostname only (full URL and query string are dropped) |
| `blob4` | coarse UA family: `mac` / `ios` / `android` / `windows` / `linux` / `bot` / `other` |
| `blob5` | city (CF edge inference; non-identifying on its own) |
| `blob6` | region / state / province |
| `blob7` | CF colo — datacenter that served the request (e.g. `YYZ`, `LHR`) |
| `double1` | HTTP status code |
| `double2` | ASN — network number, useful to distinguish residential vs cloud/datacenter |

No cookies, no client-side JS tracker, **no raw IP**, no personally-identifying headers retained. Country / city / region / ASN are all derived at the CF edge from the inbound request without storing the address itself.

A few more sample queries with the new fields:

```sql
-- top cities in the last month
SELECT blob5 AS city, blob6 AS region, blob2 AS country, count() AS hits
FROM receipts_hits
WHERE index1 = 'receipts.example.com'
  AND blob5 != ''
  AND timestamp > NOW() - INTERVAL '30' DAY
GROUP BY city, region, country
ORDER BY hits DESC
LIMIT 20;

-- bot vs datacenter vs human (ASN buckets)
SELECT
  multiIf(blob4 = 'bot', 'self-declared-bot',
          double2 > 0 AND blob4 IN ('mac','ios','android','windows','linux'), 'human',
          'datacenter-or-unknown') AS audience,
  count() AS hits
FROM receipts_hits
WHERE index1 = 'receipts.example.com'
  AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY audience
ORDER BY hits DESC;

-- which CF datacenters are serving the most hits (fun one)
SELECT blob7 AS colo, count() AS hits
FROM receipts_hits
WHERE index1 = 'receipts.example.com'
  AND blob7 != ''
  AND timestamp > NOW() - INTERVAL '7' DAY
GROUP BY colo ORDER BY hits DESC;
```

---

## Rolling back a bad deploy

CF Pages keeps every deploy forever. If something lands broken:

Dashboard → your Pages project → **Deployments** → find the last good one → **⋯ menu → Rollback to this deployment**.

Or via Wrangler:

```bash
npx wrangler pages deployment list --project-name receipts
npx wrangler pages rollback <deployment-id> --project-name receipts
```

---

## Troubleshooting

**Function build errors on deploy.** CF Pages auto-detects `functions/` and compiles TS. If the middleware fails to compile, the deploy aborts. Fix by opening the deploy log (Deployments → click the failed one).

**Analytics Engine dataset not populating.** The binding name must match exactly (`HITS`). After adding the binding, re-deploy once; the function only sees bindings from its own deploy.

**Deploy is stuck.** CF Pages has 5 concurrent builds max on the free tier. A stuck build usually means GitHub auth expired — reconnect it in Pages → Settings → Source.
