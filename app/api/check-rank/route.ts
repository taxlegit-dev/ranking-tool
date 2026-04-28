export const runtime = "nodejs";

const MAX_RESULTS = 100;
const SEARLO_TIMEOUT_MS = Number(process.env.SEARLO_TIMEOUT_MS || "20000");
const SEARLO_RESULTS_PER_PAGE = 10;
const SEARLO_MIN_REQUEST_INTERVAL_MS = Math.max(
  0,
  Number(process.env.SEARLO_MIN_REQUEST_INTERVAL_MS || "1200"),
);
const SEARLO_SAFE = (process.env.SEARLO_SAFE || "").trim().toLowerCase();
const SEARLO_LR = (process.env.SEARLO_LR || "").trim();
const SEARLO_API_BASE_URL =
  process.env.SEARLO_API_BASE_URL || "https://api.searlo.tech/api/v1/search/web";
const SEARLO_API_KEY = (process.env.SEARLO_API_KEY || "").trim();
const KEYWORD_DELAY_MS = Number(process.env.GOOGLE_REQUEST_DELAY_MS || "500");

let searloQueue: Promise<void> = Promise.resolve();
let searloLastRequestAt = 0;

interface SearchGoogleResponse {
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

function decodeGoogleRedirect(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host.endsWith("google.com") && parsed.pathname === "/url") {
      const destination = parsed.searchParams.get("q") ?? parsed.searchParams.get("url");
      if (destination) return destination;
    }
  } catch {
    // ignore
  }
  return url;
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
  const searchInformation = entry.searchInformation;
  if (searchInformation && typeof searchInformation === "object") {
    const hasNextPage = (searchInformation as { hasNextPage?: unknown }).hasNextPage;
    if (hasNextPage === true) return true;
  }
  const nextPage = entry.nextPage;
  if (typeof nextPage === "number") return Number.isFinite(nextPage) && nextPage > 0;
  if (typeof nextPage === "string") return nextPage.trim().length > 0;
  return false;
}

async function runSearloQueued<T>(task: () => Promise<T>): Promise<T> {
  let release: () => void = () => undefined;
  const turn = searloQueue;
  searloQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await turn;
  try {
    const elapsed = Date.now() - searloLastRequestAt;
    const waitMs = Math.max(0, SEARLO_MIN_REQUEST_INTERVAL_MS - elapsed);
    if (waitMs > 0) {
      await sleep(waitMs + randomBetween(80, 260));
    }
    return await task();
  } finally {
    searloLastRequestAt = Date.now();
    release();
  }
}

async function searchWithSearlo(
  keyword: string,
  country: string,
  state: string,
  log: (msg: string) => void,
  targetDomain?: string,
): Promise<SearchGoogleResponse> {
  if (!SEARLO_API_KEY) {
    return { links: [], error: "SEARLO_API_KEY is not configured." };
  }

  const q = (state ? `${keyword} ${state}` : keyword).trim().slice(0, 500);
  if (!q) return { links: [], error: "Search query is empty." };

  const links: string[] = [];
  const seen = new Set<string>();
  const gl = (country || "").trim().toLowerCase();
  const maxPages = Math.ceil(MAX_RESULTS / SEARLO_RESULTS_PER_PAGE);

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    if (links.length >= MAX_RESULTS) break;

    const params = new URLSearchParams({
      q,
      limit: String(SEARLO_RESULTS_PER_PAGE),
      page: String(pageNumber),
    });

    if (gl) params.set("gl", gl);
    if (SEARLO_SAFE === "active" || SEARLO_SAFE === "off") params.set("safe", SEARLO_SAFE);
    if (SEARLO_LR) params.set("lr", SEARLO_LR);

    log(`→ Page ${pageNumber}/${maxPages} fetching...`);
    const t0 = Date.now();

    let response: Response;
    try {
      response = await runSearloQueued(() =>
        fetch(`${SEARLO_API_BASE_URL}?${params.toString()}`, {
          method: "GET",
          headers: { "x-api-key": SEARLO_API_KEY },
          cache: "no-store",
          signal: AbortSignal.timeout(SEARLO_TIMEOUT_MS),
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`✗ Page ${pageNumber} request failed (${Date.now() - t0}ms): ${message}`);
      if (links.length > 0) {
        log(`⚠ Stopping early — using ${links.length} results from previous pages`);
        break;
      }
      return { links, error: `Searlo request failed on page ${pageNumber}: ${message}` };
    }

    log(`← Page ${pageNumber} responded: HTTP ${response.status} (${Date.now() - t0}ms)`);

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`✗ Page ${pageNumber} invalid JSON: ${message}`);
      if (links.length > 0) {
        log(`⚠ Stopping early — using ${links.length} results from previous pages`);
        break;
      }
      return { links, error: `Searlo returned invalid JSON on page ${pageNumber}: ${message}` };
    }

    if (!response.ok) {
      const errorMessage =
        typeof payload === "object" && payload && "message" in payload
          ? String((payload as { message: unknown }).message)
          : typeof payload === "object" && payload && "error" in payload
            ? String((payload as { error: unknown }).error)
            : `HTTP ${response.status}`;
      log(`✗ Page ${pageNumber} API error: ${errorMessage}`);
      if (links.length > 0) {
        log(`⚠ Stopping early — using ${links.length} results from previous pages`);
        break;
      }
      return { links, error: `Searlo API error on page ${pageNumber}: ${errorMessage}` };
    }

    if (
      typeof payload === "object" &&
      payload &&
      "success" in payload &&
      (payload as { success: unknown }).success === false
    ) {
      const message =
        "message" in payload ? String((payload as { message: unknown }).message) : "Unknown error";
      log(`✗ Page ${pageNumber} rejected: ${message}`);
      if (links.length > 0) {
        log(`⚠ Stopping early — using ${links.length} results from previous pages`);
        break;
      }
      return { links, error: `Searlo API rejected request on page ${pageNumber}: ${message}` };
    }

    const items = pickSearchItems(payload);
    if (!items) {
      log(`✗ Page ${pageNumber} response missing items array`);
      if (links.length > 0) {
        log(`⚠ Stopping early — using ${links.length} results from previous pages`);
        break;
      }
      return { links, error: `Searlo response is missing items on page ${pageNumber}.` };
    }

    const countBefore = links.length;
    for (const item of items) {
      const raw = pickUrlFromSearchItem(item);
      if (!raw) continue;
      const decoded = decodeGoogleRedirect(raw);
      if (!isOrganicLink(decoded)) continue;
      if (seen.has(decoded)) continue;
      seen.add(decoded);
      links.push(decoded);
      if (links.length >= MAX_RESULTS) break;
    }

    const newLinks = links.length - countBefore;
    const hasNext = hasSearloNextPage(payload);
    log(`✓ Page ${pageNumber} done — +${newLinks} results (total: ${links.length}) hasNextPage: ${hasNext}`);

    if (targetDomain) {
      const found = links.some(
        (url) => {
          const d = extractDomain(url);
          return d === targetDomain || d.endsWith(`.${targetDomain}`);
        },
      );
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
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      function send(event: string, data: unknown) {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      }

      function log(keyword: string, msg: string) {
        console.log(`[searlo][${keyword}] ${msg}`);
        send("log", { keyword, message: msg });
      }

      for (let i = 0; i < keywords.length; i++) {
        const keyword = keywords[i].trim();
        if (!keyword) continue;

        if (i > 0) await sleep(KEYWORD_DELAY_MS + randomBetween(200, 1200));

        log(keyword, `Starting rank check for "${keyword}"`);

        try {
          const { links, error: searchError } = await searchWithSearlo(
            keyword,
            country,
            city,
            (msg) => log(keyword, msg),
            targetDomain,
          );

          if (searchError) {
            log(keyword, `⚠ Search error: ${searchError}`);
          }

          let yourRank: number | null = null;
          let yourRankedUrl = "";
          const topRankedUrl = links[0] || "";
          const topRankedSite = topRankedUrl ? extractDomain(topRankedUrl) : "";

          for (let pos = 0; pos < links.length; pos++) {
            const linkDomain = extractDomain(links[pos]);
            if (linkDomain === targetDomain || linkDomain.endsWith(`.${targetDomain}`)) {
              yourRank = pos + 1;
              yourRankedUrl = links[pos];
              break;
            }
          }

          if (yourRank) {
            log(keyword, `✅ "${keyword}" ranked #${yourRank} → ${yourRankedUrl}`);
          } else {
            log(keyword, `✗ "${keyword}" not found in top ${links.length} results`);
          }

          const result: RankResult = {
            keyword,
            country,
            city,
            yourRank,
            yourRankedUrl,
            topRankedSite,
            topRankedUrl,
            checkedAt: new Date().toISOString(),
            error: searchError,
          };

          send("result", result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log(keyword, `✗ Unexpected error: ${message}`);

          send("result", {
            keyword,
            country,
            city,
            yourRank: null,
            yourRankedUrl: "",
            topRankedSite: "",
            topRankedUrl: "",
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
