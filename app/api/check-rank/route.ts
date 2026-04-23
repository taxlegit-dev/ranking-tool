import fs from "node:fs/promises";
import path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer";

export const runtime = "nodejs";

const MAX_RESULTS = 100;
const RESULTS_PER_PAGE = 10;
const NAVIGATION_TIMEOUT_MS = Number(process.env.GOOGLE_NAV_TIMEOUT_MS || "20000");
const KEYWORD_DELAY_MS = Number(process.env.GOOGLE_REQUEST_DELAY_MS || "500");
const PRE_SEARCH_DELAY_MS = Number(process.env.GOOGLE_PRE_SEARCH_DELAY_MS || "10000");
const TYPE_DELAY_MS = Number(process.env.GOOGLE_TYPE_DELAY_MS || "120");
const RUN_HEADLESS = process.env.GOOGLE_HEADLESS === "true";
const COOKIE_FILE =
  process.env.GOOGLE_COOKIES_FILE ||
  path.join(/*turbopackIgnore: true*/ process.cwd(), ".cache", "google-cookies.json");
const PROFILE_DIR =
  process.env.GOOGLE_PROFILE_DIR ||
  path.join(/*turbopackIgnore: true*/ process.cwd(), ".cache", "google-profile");

let sharedBrowserPromise: Promise<Browser> | null = null;

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
    // Ignore parse failures; validation happens later.
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

async function configureDevice(page: Page, device: DeviceType): Promise<void> {
  if (device === "mobile") {
    await page.setViewport({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    await page.setUserAgent(
      "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
    );
    return;
  }

  await page.setViewport({
    width: 1366,
    height: 900,
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1,
  });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  );
}

async function maybeAcceptConsent(page: Page): Promise<void> {
  const commonSelectors = [
    "button#L2AGLb",
    'button[aria-label="Accept all"]',
    'button[aria-label="I agree"]',
  ];

  for (const selector of commonSelectors) {
    const button = await page.$(selector);
    if (!button) continue;

    await Promise.allSettled([button.click(), page.waitForNavigation({ timeout: 3000 })]);
    return;
  }

  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const target = buttons.find((button) => {
      const text = (button.textContent || "").trim().toLowerCase();
      return (
        text.includes("accept all") ||
        text.includes("i agree") ||
        text.includes("accept")
      );
    });
    target?.click();
  });
}

async function loadCookies(page: Page): Promise<void> {
  try {
    const raw = await fs.readFile(COOKIE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return;
    await page.setCookie(...(parsed as Parameters<Page["setCookie"]>[0][]));
  } catch {
    // Cookie file is optional.
  }
}

async function saveCookies(page: Page): Promise<void> {
  try {
    const cookies = await page.cookies();
    await fs.mkdir(path.dirname(COOKIE_FILE), { recursive: true });
    await fs.writeFile(COOKIE_FILE, JSON.stringify(cookies, null, 2), "utf8");
  } catch (err) {
    console.error("[check-rank] Failed to persist cookies", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function doHumanBehavior(page: Page): Promise<void> {
  const viewport = page.viewport();
  const width = viewport?.width || 1366;
  const height = viewport?.height || 900;

  await page.mouse.move(
    randomBetween(40, Math.max(80, width - 40)),
    randomBetween(80, Math.max(120, height - 80)),
    { steps: randomBetween(8, 20) },
  );

  await page.evaluate(() => {
    window.scrollBy(0, Math.floor(window.innerHeight * 0.6));
  });
  await sleep(randomBetween(300, 800));
  await page.evaluate(() => {
    window.scrollBy(0, -Math.floor(window.innerHeight * 0.3));
  });
}

async function readOrganicLinksFromPage(page: Page): Promise<string[]> {
  const rawLinks = await page.evaluate(() => {
    const anchorsWithHeading = Array.from(document.querySelectorAll("a h3"))
      .map((heading) => heading.closest("a"))
      .filter((anchor): anchor is HTMLAnchorElement => Boolean(anchor?.href))
      .map((anchor) => anchor.href);

    if (anchorsWithHeading.length > 0) {
      return anchorsWithHeading;
    }

    return Array.from(document.querySelectorAll("#search a[href]"))
      .map((anchor) => (anchor as HTMLAnchorElement).href)
      .filter(Boolean);
  });

  const links: string[] = [];
  const seen = new Set<string>();

  for (const raw of rawLinks) {
    const decoded = decodeGoogleRedirect(raw);
    if (!isOrganicLink(decoded)) continue;
    if (seen.has(decoded)) continue;

    seen.add(decoded);
    links.push(decoded);
  }

  return links;
}

async function searchGoogleWithBrowser(
  page: Page,
  keyword: string,
  country: string,
  state: string,
): Promise<SearchGoogleResponse> {
  const q = state ? `${keyword} ${state}` : keyword;
  const gl = (country || "").toLowerCase() || "us";
  const allLinks: string[] = [];
  const seen = new Set<string>();

  try {
    await page.goto(`https://www.google.com/?hl=en&gl=${encodeURIComponent(gl)}&pws=0`, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      links: allLinks,
      error: `Browser navigation failed: ${message}`,
    };
  }

  await maybeAcceptConsent(page);
  await loadCookies(page);
  await page.reload({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
  await maybeAcceptConsent(page);

  await sleep(PRE_SEARCH_DELAY_MS + randomBetween(500, 1500));
  await doHumanBehavior(page);

  try {
    await page.waitForSelector("textarea[name='q'], input[name='q']", {
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    await page.click("textarea[name='q'], input[name='q']");
    await page.keyboard.down("Control");
    await page.keyboard.press("A");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    await page.type("textarea[name='q'], input[name='q']", q, {
      delay: TYPE_DELAY_MS,
    });
    await sleep(randomBetween(200, 900));
    await Promise.all([
      page.keyboard.press("Enter"),
      page.waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: NAVIGATION_TIMEOUT_MS,
      }),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { links: allLinks, error: `Search box interaction failed: ${message}` };
  }

  for (let pageIndex = 0; pageIndex < MAX_RESULTS / RESULTS_PER_PAGE; pageIndex++) {
    const blocked = await page.evaluate(() => {
      const bodyText = (document.body?.innerText || "").toLowerCase();
      return (
        bodyText.includes("our systems have detected unusual traffic") ||
        bodyText.includes("not a robot")
      );
    });

    if (blocked) {
      return {
        links: allLinks,
        error: "Google blocked automated search (captcha/unusual traffic).",
      };
    }

    const pageLinks = await readOrganicLinksFromPage(page);
    for (const link of pageLinks) {
      if (seen.has(link)) continue;
      seen.add(link);
      allLinks.push(link);
      if (allLinks.length >= MAX_RESULTS) break;
    }

    if (allLinks.length >= MAX_RESULTS || pageLinks.length < RESULTS_PER_PAGE) {
      break;
    }

    const nextLink =
      (await page.$("a#pnnext")) ||
      (await page.$("a[aria-label='Next']")) ||
      (await page.$("a[aria-label='Next page']"));

    if (!nextLink) break;

    try {
      await doHumanBehavior(page);
      await sleep(randomBetween(300, 900));
      await Promise.all([
        nextLink.click(),
        page.waitForNavigation({
          waitUntil: "domcontentloaded",
          timeout: NAVIGATION_TIMEOUT_MS,
        }),
      ]);
    } catch {
      break;
    }
  }

  await saveCookies(page);
  return { links: allLinks.slice(0, MAX_RESULTS), error: null };
}

async function getSharedBrowser(): Promise<Browser> {
  if (!sharedBrowserPromise) {
    sharedBrowserPromise = fs
      .mkdir(PROFILE_DIR, { recursive: true })
      .then(() =>
        puppeteer.launch({
          headless: RUN_HEADLESS,
          userDataDir: PROFILE_DIR,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-blink-features=AutomationControlled",
          ],
        }),
      )
      .catch((err) => {
        sharedBrowserPromise = null;
        throw err;
      });
  }
  return sharedBrowserPromise;
}

export async function POST(request: Request) {
  const body = await request.json();
  const { keywords, domain, country, city, device } = body as {
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

  const normalizedDevice: DeviceType = device === "mobile" ? "mobile" : "desktop";
  const targetDomain = normalizeDomain(domain.trim());
  const results: RankResult[] = [];

  let page: Page | null = null;

  try {
    const browser = await getSharedBrowser();
    page = await browser.newPage();
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    await configureDevice(page, normalizedDevice);
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
    });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", {
        get: () => false,
      });
    });

    for (let i = 0; i < keywords.length; i++) {
      const keyword = keywords[i].trim();
      if (!keyword) continue;

      const baseDelay = i > 0 ? KEYWORD_DELAY_MS : 0;
      await sleep(baseDelay + randomBetween(200, 1200));

      try {
        const { links, error: searchError } = await searchGoogleWithBrowser(
          page,
          keyword,
          country,
          city,
        );

        if (searchError) {
          console.error("[check-rank] Browser search finished with warning", {
            keyword,
            country,
            city,
            searchError,
          });
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

        results.push({
          keyword,
          country,
          city,
          yourRank,
          yourRankedUrl,
          topRankedSite,
          topRankedUrl,
          checkedAt: new Date().toISOString(),
          error: searchError,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[check-rank] Unexpected keyword failure", {
          keyword,
          country,
          city,
          error: message,
        });

        results.push({
          keyword,
          country,
          city,
          yourRank: null,
          yourRankedUrl: "",
          topRankedSite: "",
          topRankedUrl: "",
          checkedAt: new Date().toISOString(),
          error: "Unexpected failure while checking this keyword.",
        });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[check-rank] Browser startup failed", { error: message });
    return Response.json(
      {
        error:
          "Could not start browser automation. Install Chromium dependency and try again.",
      },
      { status: 500 },
    );
  } finally {
    if (page) {
      await page.close().catch(() => undefined);
    }
  }

  return Response.json({ results });
}
