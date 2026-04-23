import axios from "axios";

const API_KEY = process.env.GOOGLE_API_KEY!;
const CSE_ID = process.env.GOOGLE_CSE_ID!;

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

interface CSEItem {
  link: string;
  displayLink: string;
  title: string;
}

interface SearchGoogleResponse {
  links: string[];
  error: string | null;
}

async function searchGoogle(
  keyword: string,
  country: string,
  state: string
): Promise<SearchGoogleResponse> {
  const q = state ? `${keyword} ${state}` : keyword;
  const gl = country.toLowerCase();

  // Custom Search API returns max 10 per request, up to start=91 (100 results total)
  const allLinks: string[] = [];
  let apiError: string | null = null;

  const requests = [1, 11, 21, 31, 41, 51, 61, 71, 81, 91];

  for (const start of requests) {
    try {
      const res = await axios.get("https://www.googleapis.com/customsearch/v1", {
        params: {
          key: API_KEY,
          cx: CSE_ID,
          q,
          gl,
          hl: "en",
          num: 10,
          start,
        },
        timeout: 10000,
      });

      const items: CSEItem[] = res.data.items || [];
      for (const item of items) {
        if (item.link) allLinks.push(item.link);
      }

      // Stop early if fewer than 10 results (no more pages)
      if (items.length < 10) break;
    } catch (err: unknown) {
      const axiosErr = err as {
        response?: {
          status?: number;
          data?: { error?: { message?: string } };
        };
      };
      const status = axiosErr?.response?.status;
      const message =
        axiosErr?.response?.data?.error?.message || "Failed to fetch search results.";

      if (status === 403) {
        apiError =
          "Google CSE access denied: enable Custom Search JSON API and billing for this API key project.";
      } else if (status === 429) {
        apiError = "Google CSE quota exceeded. Try again later or increase quota.";
      } else if (status === 400) {
        apiError = `Google CSE request error: ${message}`;
      } else {
        apiError = `Google CSE error${status ? ` (${status})` : ""}: ${message}`;
      }
      break;
    }
  }

  return { links: allLinks, error: apiError };
}

export async function POST(request: Request) {
  if (!API_KEY || !CSE_ID) {
    return Response.json(
      { error: "GOOGLE_API_KEY and GOOGLE_CSE_ID must be set in .env.local" },
      { status: 500 }
    );
  }

  const body = await request.json();
  const { keywords, domain, country, city, device } = body as {
    keywords: string[];
    domain: string;
    country: string;
    city: string;
    device: string;
  };

  // device is accepted but CSE does not differentiate; kept for future use
  void device;

  const targetDomain = domain
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .toLowerCase();

  const results = [];

  for (let i = 0; i < keywords.length; i++) {
    const keyword = keywords[i].trim();
    if (!keyword) continue;

    if (i > 0) {
      // Small delay between keywords to respect quota
      await new Promise((r) => setTimeout(r, 500));
    }

    try {
      const { links, error: searchError } = await searchGoogle(keyword, country, city);

      let yourRank: number | null = null;
      let yourRankedUrl = "";
      const topRankedUrl = links[0] || "";
      const topRankedSite = topRankedUrl ? extractDomain(topRankedUrl) : "";

      for (let pos = 0; pos < links.length; pos++) {
        const linkDomain = extractDomain(links[pos]).toLowerCase();
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
    } catch {
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

  return Response.json({ results });
}
