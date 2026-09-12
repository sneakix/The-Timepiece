// ============================================================
// The Timepiece - catalog caching proxy (Cloudflare Worker)
// ============================================================
// What this does: sits between the site and your Google Sheet. Instead of
// every visitor's browser hitting Google directly (slow, and Google will
// rate-limit / throttle a published CSV under real traffic), visitors hit
// this Worker, which fetches the sheet on their behalf and caches the
// result for a short time - so ten visitors in the same minute cause one
// real request to Google, not ten.
//
// ---------- Setup (one-time) ----------
// 1. Go to https://dash.cloudflare.com -> Workers & Pages -> Create ->
//    "Create Worker". Give it a name, e.g. "thetimepiece-catalog-cache".
// 2. Delete the placeholder code it starts you with, paste this file in
//    instead, and click Deploy.
// 3. Below, replace SHEET_CSV_URL with your own sheet's
//    "File -> Share -> Publish to web -> CSV" link (the one you already
//    have - it looks like https://docs.google.com/spreadsheets/d/e/.../pub?...&output=csv).
// 4. Redeploy after editing SHEET_CSV_URL.
// 5. Copy the *.workers.dev URL Cloudflare gives this Worker (shown on its
//    overview page) and paste THAT into GOOGLE_SHEET_CSV_URL near the top
//    of index.html - not the raw Google link, this Worker's own URL.
//
// That's it. To update products, just edit the Google Sheet as normal -
// nothing here needs to change again unless you swap sheets entirely.

const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vShf6C1KtwDBh3wQxcJFxymIJCsx-NuM1bqc1EoNakdvQTx9gbJWgZ6-w2LsB5zUT9CHD7o9ItJP0A-/pub?gid=0&single=true&output=csv";

// How long the Worker will keep serving a cached copy before fetching a
// fresh one from Google. Kept short (2 minutes) since the whole point of
// this catalog is that price/stock edits in the sheet should show up on
// the live site quickly - raise this if your traffic is high enough that
// Google's rate limit becomes a problem again even with caching.
const CACHE_SECONDS = 120;

export default {
  async fetch(request) {
    const cache = caches.default;
    // Cache Worker responses per Worker URL, not per incoming request -
    // this endpoint ignores query strings/method entirely and always
    // returns the same sheet, so a single fixed cache key means every
    // visitor shares one cached copy instead of each unique request URL
    // getting its own.
    const cacheKey = new Request("https://cache-key.internal/catalog.csv");

    let response = await cache.match(cacheKey);
    if (response) {
      return withCors(response);
    }

    let upstream;
    try {
      upstream = await fetch(SHEET_CSV_URL, {
        headers: { "User-Agent": "TheTimepiece-CatalogCache/1.0" }
      });
    } catch (err) {
      return withCors(new Response("Upstream fetch failed: " + err.message, { status: 502 }));
    }

    if (!upstream.ok) {
      return withCors(new Response(`Upstream returned ${upstream.status}`, { status: 502 }));
    }

    const body = await upstream.text();
    response = new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
      },
    });

    // Fire-and-forget: store in Cloudflare's edge cache for next time.
    // Wrapped separately from the returned response so the visitor isn't
    // held up waiting for the cache write to finish.
    await cache.put(cacheKey, response.clone());

    return withCors(response);
  },
};

// Allows the site (any origin - it's public product data, not sensitive)
// to read this response via fetch()/PapaParse in the browser.
function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, { status: response.status, headers });
}
