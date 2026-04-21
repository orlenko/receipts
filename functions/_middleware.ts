// Pages Function middleware: runs at the edge on every request to the site.
// Writes one anonymous hit to Cloudflare Analytics Engine per request, then
// forwards the response unchanged. No cookies, no client-side JS involved.
//
// Binding: `HITS` must be defined in the Pages project settings (Settings →
// Functions → Bindings → Analytics Engine → variable name `HITS`, dataset
// name of your choice, e.g. `receipts_hits`). If the binding is missing the
// function still serves the request — the write is wrapped in try/catch.
//
// Data written per request:
//   indexes[0] -> hostname (useful if you add more subdomains to one dataset)
//   blobs[0]   -> URL path
//   blobs[1]   -> country (derived at CF edge; no raw IP stored)
//   blobs[2]   -> referer (truncated)
//   blobs[3]   -> user-agent family, truncated (coarse)
//   doubles[0] -> HTTP status code
//
// Query examples in HOW_TO_DEPLOY.md.

interface Env {
  HITS?: AnalyticsEngineDataset;
}

// Minimal UA normalizer: keeps us from logging full UA strings while still
// distinguishing "phone vs desktop vs bot" in aggregate.
function uaFamily(ua: string): string {
  if (!ua) return '';
  if (/bot|crawl|spider|curl|wget|headless/i.test(ua)) return 'bot';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (/android/i.test(ua)) return 'android';
  if (/mac os x/i.test(ua)) return 'mac';
  if (/windows nt/i.test(ua)) return 'windows';
  if (/linux/i.test(ua)) return 'linux';
  return 'other';
}

function shortReferer(ref: string): string {
  if (!ref) return '';
  try { return new URL(ref).hostname; } catch { return ''; }
}

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const response = await ctx.next();
  try {
    if (ctx.env.HITS) {
      const url = new URL(ctx.request.url);
      // Skip writes for common noise paths so the dataset stays signal-heavy.
      if (url.pathname !== '/favicon.ico' && !url.pathname.startsWith('/.well-known/')) {
        ctx.env.HITS.writeDataPoint({
          indexes: [url.hostname],
          blobs: [
            url.pathname,
            (ctx.request.cf?.country as string | undefined) ?? '',
            shortReferer(ctx.request.headers.get('referer') ?? ''),
            uaFamily(ctx.request.headers.get('user-agent') ?? ''),
          ],
          doubles: [response.status],
        });
      }
    }
  } catch {
    // Never fail a request because of analytics. Silent drop is fine.
  }
  return response;
};
