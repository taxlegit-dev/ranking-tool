export const runtime = "nodejs";

const MAX_RESULTS = 100;
const RESULTS_PER_PAGE = 10;
const KEYWORD_DELAY_MS = Number(process.env.GOOGLE_REQUEST_DELAY_MS || "1000");

// Serper
const SERPER_API_KEY = (process.env.SERPER_API_KEY || "").trim();
const SERPER_BASE_URL = "https://google.serper.dev/search";
const SERPER_TIMEOUT_MS = Number(process.env.SERPER_TIMEOUT_MS || "30000");

// Searlo (fallback / legacy)
const SEARLO_API_KEY = (process.env.SEARLO_API_KEY || "").trim();
const SEARLO_API_BASE_URL =
  process.env.SEARLO_API_BASE_URL || "https://api.searlo.tech/api/v1/search/web";
const SEARLO_TIMEOUT_MS = Number(process.env.SEARLO_TIMEOUT_MS || "45000");
const SEARLO_MIN_REQUEST_INTERVAL_MS = Math.max(
  0,
  Number(process.env.SEARLO_MIN_REQUEST_INTERVAL_MS || "1200"),
);
const SEARLO_SAFE = (process.env.SEARLO_SAFE || "").trim().toLowerCase();
const SEARLO_LR = (process.env.SEARLO_LR || "").trim();
const RATE_LIMIT_COOLDOWN_MS = Number(process.env.SEARLO_RATE_LIMIT_COOLDOWN_MS || "15000");
const RATE_LIMIT_MAX_RETRIES = 3;

const SEARCH_PROVIDER = (
  process.env.RANK_SEARCH_PROVIDER || (SERPER_API_KEY ? "serper" : "searlo")
).toLowerCase();

let searloQueue: Promise<void> = Promise.resolve();
let searloLastRequestAt = 0;
let searloHitCount = 0;
let searloWindowStartAt = Date.now();
const SEARLO_HITS_PER_WINDOW = 10;
const SEARLO_WINDOW_COOLDOWN_MS = 40000;

interface SearchResponse {
  links: string[];
  error: string | null;
}

interface RankResult {
  keyword: string;
  country: string;
  city: string;
  yourRank: number | null;
  yourRankedUrl: string;
  topRankedSite: string;
  topRankedUrl: string;
  checkedAt: string;
  error: string | null;
}

type DeviceType = "desktop" | "mobile";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function normalizeDomain(input: string): string {
  return input
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .toLowerCase();
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function isOrganicLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const hostname = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (hostname === "google.com" || hostname.endsWith(".google.com")) return false;
    if (hostname === "webcache.googleusercontent.com") return false;
    return true;
  } catch {
    return false;
  }
}

// ─── Serper ──────────────────────────────────────────────────────────────────

async function searchWithSerper(
  keyword: string,
  country: string,
  city: string,
  log: (msg: string) => void,
  targetDomain?: string,
): Promise<SearchResponse> {
  if (!SERPER_API_KEY) {
    return { links: [], error: "SERPER_API_KEY is not configured." };
  }

  const q = (city ? `${keyword} ${city}` : keyword).trim().slice(0, 500);
  const gl = (country || "us").trim().toLowerCase();
  const links: string[] = [];
  const seen = new Set<string>();
  const maxPages = Math.ceil(MAX_RESULTS / RESULTS_PER_PAGE);

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    if (links.length >= MAX_RESULTS) break;

    log(`→ Page ${pageIndex + 1}/${maxPages} fetching...`);
    const t0 = Date.now();

    let response: Response;
    try {
      response = await fetch(SERPER_BASE_URL, {
        method: "POST",
        headers: {
          "X-API-KEY": SERPER_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          q,
          gl,
          hl: "en",
          num: RESULTS_PER_PAGE,
          page: pageIndex + 1,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(SERPER_TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`✗ Page ${pageIndex + 1} request failed (${Date.now() - t0}ms): ${message}`);
      if (links.length > 0) { log(`⚠ Stopping early — ${links.length} results saved`); break; }
      return { links, error: `Serper request failed: ${message}` };
    }

    log(`← Page ${pageIndex + 1} responded: HTTP ${response.status} (${Date.now() - t0}ms)`);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`✗ Page ${pageIndex + 1} invalid JSON: ${message}`);
      if (links.length > 0) { log(`⚠ Stopping early — ${links.length} results saved`); break; }
      return { links, error: `Serper invalid JSON: ${message}` };
    }

    if (!response.ok) {
      const errorMessage =
        typeof payload === "object" && payload && "message" in payload
          ? String((payload as { message: unknown }).message)
          : `HTTP ${response.status}`;
      log(`✗ Page ${pageIndex + 1} API error: ${errorMessage}`);
      if (links.length > 0) { log(`⚠ Stopping early — ${links.length} results saved`); break; }
      return { links, error: `Serper error: ${errorMessage}` };
    }

    // Serper response: { organic: [{ link, title, snippet, position }] }
    const organic = (payload as Record<string, unknown>).organic;
    if (!Array.isArray(organic) || organic.length === 0) {
      log(`■ No more organic results at page ${pageIndex + 1}`);
      break;
    }

    const countBefore = links.length;
    for (const item of organic) {
      const url = typeof item === "object" && item && "link" in item
        ? String((item as { link: unknown }).link)
        : null;
      if (!url || !isOrganicLink(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      links.push(url);
      if (links.length >= MAX_RESULTS) break;
    }

    const newLinks = links.length - countBefore;
    log(`✓ Page ${pageIndex + 1} done — +${newLinks} results (total: ${links.length})`);

    // Log all domains on this page for debugging
    const pageDomains = links.slice(countBefore).map((url) => extractDomain(url));
    log(`   Domains: ${pageDomains.join(", ")}`);

    if (targetDomain) {
      const found = links.some((url) => {
        const d = extractDomain(url);
        return d === targetDomain || d.endsWith(`.${targetDomain}`);
      });
      if (found) {
        log(`■ Domain found — stopping early (saved ${maxPages - pageIndex - 1} credits)`);
        break;
      }
      log(`   "${targetDomain}" not in this page, continuing...`);
    }

    if (organic.length === 0) {
      log(`■ No more pages — done at page ${pageIndex + 1}`);
      break;
    }

    if (pageIndex < maxPages - 1) await sleep(randomBetween(300, 800));
  }

  return { links: links.slice(0, MAX_RESULTS), error: null };
}

// ─── Searlo ─────────────────────────────────────────────────────────────────

async function runSearloQueued<T>(task: () => Promise<T>, log?: (msg: string) => void): Promise<T> {
  let release: () => void = () => undefined;
  const turn = searloQueue;
  searloQueue = new Promise<void>((resolve) => { release = resolve; });

  await turn;
  try {
    const elapsed = Date.now() - searloLastRequestAt;
    const waitMs = Math.max(0, SEARLO_MIN_REQUEST_INTERVAL_MS - elapsed);
    if (waitMs > 0) await sleep(waitMs + randomBetween(80, 260));

    searloHitCount++;
    if (searloHitCount > SEARLO_HITS_PER_WINDOW) {
      const windowElapsed = Date.now() - searloWindowStartAt;
      const cooldownRemaining = SEARLO_WINDOW_COOLDOWN_MS - windowElapsed;
      if (cooldownRemaining > 0) {
        const waitSec = Math.ceil(cooldownRemaining / 1000);
        log?.(`⏳ 10 hits reached — cooling down ${waitSec}s to avoid rate limit...`);
        await sleep(cooldownRemaining + randomBetween(500, 1500));
      }
      searloHitCount = 1;
      searloWindowStartAt = Date.now();
    }

    return await task();
  } finally {
    searloLastRequestAt = Date.now();
    release();
  }
}

function pickUrlFromSearchItem(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const entry = item as Record<string, unknown>;
  for (const field of ["url", "link", "href", "destinationUrl", "destination"]) {
    const value = entry[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function pickSearchItems(payload: unknown): unknown[] | null {
  if (!payload || typeof payload !== "object") return null;
  const entry = payload as Record<string, unknown>;
  for (const field of ["items", "organic", "results"]) {
    const value = entry[field];
    if (Array.isArray(value)) return value;
  }
  return null;
}

function hasSearloNextPage(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const entry = payload as Record<string, unknown>;
  const si = entry.searchInformation;
  if (si && typeof si === "object") {
    if ((si as { hasNextPage?: unknown }).hasNextPage === true) return true;
  }
  const np = entry.nextPage;
  if (typeof np === "number") return Number.isFinite(np) && np > 0;
  if (typeof np === "string") return np.trim().length > 0;
  return false;
}

function decodeGoogleRedirect(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase().endsWith("google.com") && parsed.pathname === "/url") {
      const dest = parsed.searchParams.get("q") ?? parsed.searchParams.get("url");
      if (dest) return dest;
    }
  } catch { /* ignore */ }
  return url;
}

async function searchWithSearlo(
  keyword: string,
  country: string,
  state: string,
  log: (msg: string) => void,
  targetDomain?: string,
): Promise<SearchResponse> {
  if (!SEARLO_API_KEY) {
    return { links: [], error: "SEARLO_API_KEY is not configured." };
  }

  const q = (state ? `${keyword} ${state}` : keyword).trim().slice(0, 500);
  if (!q) return { links: [], error: "Search query is empty." };

  const links: string[] = [];
  const seen = new Set<string>();
  const gl = (country || "").trim().toLowerCase();
  const maxPages = Math.ceil(MAX_RESULTS / RESULTS_PER_PAGE);

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    if (links.length >= MAX_RESULTS) break;

    const params = new URLSearchParams({ q, limit: "10", page: String(pageNumber) });
    if (gl) params.set("gl", gl);
    if (SEARLO_SAFE === "active" || SEARLO_SAFE === "off") params.set("safe", SEARLO_SAFE);
    if (SEARLO_LR) params.set("lr", SEARLO_LR);

    log(`→ Page ${pageNumber}/${maxPages} fetching...`);

    let response: Response;
    let payload: unknown = null;
    let pageError: string | null = null;

    for (let attempt = 1; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
      const t0 = Date.now();
      try {
        response = await runSearloQueued(() =>
          fetch(`${SEARLO_API_BASE_URL}?${params.toString()}`, {
            method: "GET",
            headers: { "x-api-key": SEARLO_API_KEY },
            cache: "no-store",
            signal: AbortSignal.timeout(SEARLO_TIMEOUT_MS),
          }), log,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`✗ Page ${pageNumber} failed (${Date.now() - t0}ms): ${message}`);
        pageError = `Searlo request failed on page ${pageNumber}: ${message}`;
        break;
      }

      log(`← Page ${pageNumber} responded: HTTP ${response!.status} (${Date.now() - t0}ms)`);
      try { payload = await response!.json(); } catch (err) {
        pageError = `Searlo invalid JSON on page ${pageNumber}: ${err instanceof Error ? err.message : String(err)}`;
        break;
      }

      if (response!.status === 429) {
        const retryAfterHeader = response!.headers.get("retry-after");
        const waitMs = Math.max((Number(retryAfterHeader) || 0) * 1000, RATE_LIMIT_COOLDOWN_MS);
        if (attempt < RATE_LIMIT_MAX_RETRIES) {
          log(`⏳ Rate limited — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${RATE_LIMIT_MAX_RETRIES})...`);
          await sleep(waitMs + randomBetween(500, 2000));
          payload = null;
          continue;
        }
        pageError = `Searlo rate limit exceeded on page ${pageNumber}`;
        break;
      }

      if (!response!.ok) {
        const errorMessage =
          typeof payload === "object" && payload && "message" in payload
            ? String((payload as { message: unknown }).message)
            : `HTTP ${response!.status}`;
        log(`✗ Page ${pageNumber} API error: ${errorMessage}`);
        pageError = `Searlo API error on page ${pageNumber}: ${errorMessage}`;
        break;
      }

      pageError = null;
      break;
    }

    if (pageError !== null) {
      if (links.length > 0) { log(`⚠ Stopping early — ${links.length} results saved`); break; }
      return { links, error: pageError };
    }

    if (typeof payload === "object" && payload && "success" in payload &&
      (payload as { success: unknown }).success === false) {
      const message = "message" in payload ? String((payload as { message: unknown }).message) : "Unknown";
      log(`✗ Page ${pageNumber} rejected: ${message}`);
      if (links.length > 0) { log(`⚠ Stopping early — ${links.length} results saved`); break; }
      return { links, error: `Searlo rejected page ${pageNumber}: ${message}` };
    }

    const items = pickSearchItems(payload);
    if (!items) {
      if (links.length > 0) { log(`⚠ Stopping early — ${links.length} results saved`); break; }
      return { links, error: `Searlo missing items on page ${pageNumber}.` };
    }

    const countBefore = links.length;
    for (const item of items) {
      const raw = pickUrlFromSearchItem(item);
      if (!raw) continue;
      const decoded = decodeGoogleRedirect(raw);
      if (!isOrganicLink(decoded) || seen.has(decoded)) continue;
      seen.add(decoded);
      links.push(decoded);
      if (links.length >= MAX_RESULTS) break;
    }

    const newLinks = links.length - countBefore;
    const hasNext = hasSearloNextPage(payload);
    log(`✓ Page ${pageNumber} done — +${newLinks} results (total: ${links.length}) hasNextPage: ${hasNext}`);

    if (targetDomain) {
      const found = links.some((url) => {
        const d = extractDomain(url);
        return d === targetDomain || d.endsWith(`.${targetDomain}`);
      });
      if (found) {
        log(`■ Domain found — stopping early (saved ${maxPages - pageNumber} page credits)`);
        break;
      }
    }

    if (!hasNext || items.length === 0 || countBefore === links.length) {
      log(`■ No more pages — done at page ${pageNumber}`);
      break;
    }
  }

  return { links: links.slice(0, MAX_RESULTS), error: null };
}

// ─── POST Handler ────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const body = await request.json();
  const { keywords, domain, country, city } = body as {
    keywords: string[];
    domain: string;
    country: string;
    city: string;
    device: DeviceType;
  };

  if (!Array.isArray(keywords) || keywords.length === 0) {
    return Response.json({ error: "At least one keyword is required." }, { status: 400 });
  }
  if (!domain?.trim()) {
    return Response.json({ error: "Target domain is required." }, { status: 400 });
  }

  const targetDomain = normalizeDomain(domain.trim());
  const useSerper = SEARCH_PROVIDER === "serper";
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: string, data: unknown) {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      }

      function log(keyword: string, msg: string) {
        console.log(`[${useSerper ? "serper" : "searlo"}][${keyword}] ${msg}`);
        send("log", { keyword, message: msg });
      }

      for (let i = 0; i < keywords.length; i++) {
        const keyword = keywords[i].trim();
        if (!keyword) continue;

        if (i > 0) await sleep(KEYWORD_DELAY_MS + randomBetween(200, 1200));

        log(keyword, `Starting rank check for "${keyword}" [${useSerper ? "Serper" : "Searlo"}]`);

        try {
          const { links, error: searchError } = useSerper
            ? await searchWithSerper(keyword, country, city, (msg) => log(keyword, msg), targetDomain)
            : await searchWithSearlo(keyword, country, city, (msg) => log(keyword, msg), targetDomain);

          if (searchError) log(keyword, `⚠ Search error: ${searchError}`);

          let yourRank: number | null = null;
          let yourRankedUrl = "";
          const topRankedUrl = links[0] || "";
          const topRankedSite = topRankedUrl ? extractDomain(topRankedUrl) : "";

          for (let pos = 0; pos < links.length; pos++) {
            const d = extractDomain(links[pos]);
            if (d === targetDomain || d.endsWith(`.${targetDomain}`)) {
              yourRank = pos + 1;
              yourRankedUrl = links[pos];
              break;
            }
          }

          if (yourRank) {
            log(keyword, `✅ Ranked #${yourRank} → ${yourRankedUrl}`);
          } else {
            log(keyword, `✗ Not found in top ${links.length} results`);
          }

          send("result", {
            keyword, country, city, yourRank, yourRankedUrl,
            topRankedSite, topRankedUrl,
            checkedAt: new Date().toISOString(),
            error: searchError,
          } satisfies RankResult);

        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log(keyword, `✗ Unexpected error: ${message}`);
          send("result", {
            keyword, country, city,
            yourRank: null, yourRankedUrl: "", topRankedSite: "", topRankedUrl: "",
            checkedAt: new Date().toISOString(),
            error: "Unexpected failure while checking this keyword.",
          } satisfies RankResult);
        }
      }

      send("done", {});
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
