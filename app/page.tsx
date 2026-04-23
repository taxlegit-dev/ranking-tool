"use client";

import { useRef, useState } from "react";
import * as XLSX from "xlsx";
import countriesData from "../countries.json";

interface CountryEntry {
  code2: string;
  code3: string;
  name: string;
  states: { code: string; name: string }[];
}

const countries = countriesData as CountryEntry[];

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

interface InputSet {
  id: string;
  keywords: string;
  domain: string;
  country: string;
  state: string;
  device: "desktop" | "mobile";
}

interface CombinedRankResult extends RankResult {
  inputName: string;
  targetDomain: string;
  device: "desktop" | "mobile";
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString();
}

function createInputSet(id: number): InputSet {
  return {
    id: `input-${id}`,
    keywords: "",
    domain: "",
    country: "IN",
    state: "",
    device: "desktop",
  };
}

export default function Home() {
  const nextInputId = useRef(2);
  const [inputSets, setInputSets] = useState<InputSet[]>([createInputSet(1)]);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<CombinedRankResult[]>([]);
  const [error, setError] = useState("");

  function addInputSet() {
    const id = nextInputId.current;
    nextInputId.current += 1;
    setInputSets((prev) => [...prev, createInputSet(id)]);
  }

  function removeInputSet(id: string) {
    setInputSets((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((item) => item.id !== id);
    });
  }

  function updateInputSet(id: string, patch: Partial<Omit<InputSet, "id">>) {
    setInputSets((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }

  function handleCountryChange(id: string, code: string) {
    updateInputSet(id, { country: code, state: "" });
  }

  async function handleCheck() {
    setError("");
    let payloads: {
      inputName: string;
      keywords: string[];
      domain: string;
      country: string;
      city: string;
      device: "desktop" | "mobile";
    }[];

    try {
      payloads = inputSets.map((item, index) => {
        const keywords = item.keywords
          .split("\n")
          .map((k) => k.trim())
          .filter(Boolean);

        if (!keywords.length) {
          throw new Error(`Input #${index + 1}: Enter at least one keyword.`);
        }
        if (!item.domain.trim()) {
          throw new Error(`Input #${index + 1}: Enter a target domain.`);
        }

        return {
          inputName: `Input #${index + 1}`,
          keywords,
          domain: item.domain.trim(),
          country: item.country,
          city: item.state.trim(),
          device: item.device,
        };
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Please verify input details.";
      setError(message);
      return;
    }

    setLoading(true);
    setResults([]);

    try {
      const settled = await Promise.allSettled(
        payloads.map(async (payload) => {
          const res = await fetch("/api/check-rank", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              keywords: payload.keywords,
              domain: payload.domain,
              country: payload.country,
              city: payload.city,
              device: payload.device,
            }),
          });

          const data = (await res.json()) as {
            results?: RankResult[];
            error?: string;
          };

          if (!res.ok) {
            throw new Error(data.error || "Request failed.");
          }

          return data.results || [];
        }),
      );

      const combined: CombinedRankResult[] = [];
      const failedInputs: string[] = [];

      settled.forEach((entry, idx) => {
        const payload = payloads[idx];
        if (entry.status === "fulfilled") {
          const mapped = entry.value.map((result) => ({
            ...result,
            inputName: payload.inputName,
            targetDomain: payload.domain,
            device: payload.device,
          }));
          combined.push(...mapped);
          return;
        }
        failedInputs.push(payload.inputName);
      });

      setResults(combined);

      if (!combined.length) {
        setError("No results returned. Please try again.");
      } else if (failedInputs.length) {
        setError(`Some inputs failed: ${failedInputs.join(", ")}.`);
      }
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Request failed. Please try again.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  function handleExport() {
    const rows = results.map((r) => ({
      Input: r.inputName,
      Keyword: r.keyword,
      "Target Domain": r.targetDomain,
      Device: r.device,
      Country: countries.find((c) => c.code2 === r.country)?.name || r.country,
      "State / City": r.city || "-",
      "Your Rank": r.error
        ? "Failed to fetch"
        : r.yourRank
          ? `#${r.yourRank}`
          : "Not in top 100",
      "Your Ranked URL": r.yourRankedUrl || "-",
      "Top Ranked Site": r.topRankedSite || "-",
      "Top Ranked URL": r.topRankedUrl || "-",
      "Checked At": formatDate(r.checkedAt),
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Rankings");
    const date = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `rank-report-${date}.xlsx`);
  }

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4 text-black">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-3xl font-bold text-gray-800 mb-2">
          SERP Keyword Rank Checker
        </h1>
        <p className="text-gray-500 mb-8 text-sm">
          Check where your domain ranks on Google for any keyword.
        </p>

        <div className="bg-white rounded-2xl shadow p-6 mb-6 space-y-5">
          {inputSets.map((item, idx) => {
            const selectedCountry =
              countries.find((c) => c.code2 === item.country) || null;
            const states = selectedCountry?.states || [];

            return (
              <div
                key={item.id}
                className="rounded-xl border border-gray-200 p-4 space-y-4"
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-700">
                    Input #{idx + 1}
                  </h3>
                  {inputSets.length > 1 && (
                    <button
                      onClick={() => removeInputSet(item.id)}
                      className="text-xs text-red-600 hover:text-red-700 font-medium"
                    >
                      Remove
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Keywords{" "}
                      <span className="text-gray-400">(one per line)</span>
                    </label>
                    <textarea
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-[140px] resize-y"
                      placeholder={
                        "mca company registration\ngstin search\nincome tax efiling"
                      }
                      value={item.keywords}
                      onChange={(e) =>
                        updateInputSet(item.id, { keywords: e.target.value })
                      }
                    />
                  </div>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Target Domain
                      </label>
                      <input
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder="mca.gov.in"
                        value={item.domain}
                        onChange={(e) =>
                          updateInputSet(item.id, { domain: e.target.value })
                        }
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Country
                      </label>
                      <select
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                        value={item.country}
                        onChange={(e) =>
                          handleCountryChange(item.id, e.target.value)
                        }
                      >
                        {countries.map((c) => (
                          <option key={c.code2} value={c.code2}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        State / City{" "}
                        <span className="text-gray-400">(optional)</span>
                      </label>
                      {states.length > 0 ? (
                        <select
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                          value={item.state}
                          onChange={(e) =>
                            updateInputSet(item.id, { state: e.target.value })
                          }
                        >
                          <option value="">-- All states --</option>
                          {states.map((s) => (
                            <option key={s.code} value={s.name}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          placeholder="City or region"
                          value={item.state}
                          onChange={(e) =>
                            updateInputSet(item.id, { state: e.target.value })
                          }
                        />
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Device
                      </label>
                      <div className="flex gap-4">
                        {(["desktop", "mobile"] as const).map((d) => (
                          <label
                            key={d}
                            className="flex items-center gap-2 cursor-pointer"
                          >
                            <input
                              type="radio"
                              name={`device-${item.id}`}
                              value={d}
                              checked={item.device === d}
                              onChange={() =>
                                updateInputSet(item.id, { device: d })
                              }
                              className="accent-blue-600"
                            />
                            <span className="text-sm capitalize text-gray-700">
                              {d}
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}

          {error && <p className="text-red-500 text-sm">{error}</p>}

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={addInputSet}
              disabled={loading}
              className="w-full md:w-auto bg-gray-200 hover:bg-gray-300 disabled:opacity-60 text-gray-800 font-semibold px-6 py-2.5 rounded-lg transition-colors"
            >
              + Add Another Input
            </button>

            <button
              onClick={handleCheck}
              disabled={loading}
              className="w-full md:w-auto bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-semibold px-8 py-2.5 rounded-lg transition-colors flex items-center gap-2"
            >
              {loading && (
                <svg
                  className="animate-spin h-4 w-4 text-white"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8v8H4z"
                  />
                </svg>
              )}
              {loading ? "Checking Rankings..." : "Check All Rankings"}
            </button>
          </div>
        </div>

        {results.length > 0 && (
          <div className="bg-white rounded-2xl shadow p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-800">
                Results ({results.length} keyword
                {results.length !== 1 ? "s" : ""})
              </h2>
              <button
                onClick={handleExport}
                className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3"
                  />
                </svg>
                Export to Excel
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left border-collapse">
                <thead>
                  <tr className="bg-gray-100 text-gray-600 text-xs uppercase tracking-wide">
                    <th className="px-3 py-3 font-semibold">Input</th>
                    <th className="px-3 py-3 font-semibold">Keyword</th>
                    <th className="px-3 py-3 font-semibold">Target Domain</th>
                    <th className="px-3 py-3 font-semibold">Device</th>
                    <th className="px-3 py-3 font-semibold">Country</th>
                    <th className="px-3 py-3 font-semibold">State / City</th>
                    <th className="px-3 py-3 font-semibold">Your Rank</th>
                    <th className="px-3 py-3 font-semibold">Your Ranked URL</th>
                    <th className="px-3 py-3 font-semibold">Top Ranked Site</th>
                    <th className="px-3 py-3 font-semibold">Top Ranked URL</th>
                    <th className="px-3 py-3 font-semibold">Checked At</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr
                      key={i}
                      className="border-t border-gray-100 hover:bg-gray-50 transition-colors"
                    >
                      <td className="px-3 py-3 text-gray-700 whitespace-nowrap">
                        {r.inputName}
                      </td>
                      <td className="px-3 py-3 font-medium text-gray-800 max-w-[160px] truncate">
                        {r.keyword}
                      </td>
                      <td
                        className="px-3 py-3 text-gray-700 max-w-[180px] truncate"
                        title={r.targetDomain}
                      >
                        {r.targetDomain}
                      </td>
                      <td className="px-3 py-3 text-gray-600 capitalize">
                        {r.device}
                      </td>
                      <td className="px-3 py-3 text-gray-600">
                        {countries.find((c) => c.code2 === r.country)?.name ||
                          r.country}
                      </td>
                      <td className="px-3 py-3 text-gray-600">
                        {r.city || "-"}
                      </td>
                      <td className="px-3 py-3 font-semibold">
                        {r.error ? (
                          <span className="text-orange-500">{r.error}</span>
                        ) : r.yourRank ? (
                          <span className="text-green-600">#{r.yourRank}</span>
                        ) : (
                          <span className="text-red-500">Not in top 100</span>
                        )}
                      </td>
                      <td className="px-3 py-3 max-w-[180px]">
                        {r.yourRankedUrl ? (
                          <a
                            href={r.yourRankedUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline truncate block"
                            title={r.yourRankedUrl}
                          >
                            {r.yourRankedUrl}
                          </a>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="px-3 py-3 text-gray-700 font-medium">
                        {r.topRankedSite || "-"}
                      </td>
                      <td className="px-3 py-3 max-w-[180px]">
                        {r.topRankedUrl ? (
                          <a
                            href={r.topRankedUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline truncate block"
                            title={r.topRankedUrl}
                          >
                            {r.topRankedUrl}
                          </a>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="px-3 py-3 text-gray-500 whitespace-nowrap">
                        {formatDate(r.checkedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
