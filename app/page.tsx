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
  const [inputSets, setInputSets] = useState<InputSet[]>([createInputSet(1)]);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<CombinedRankResult[]>([]);
  const [error, setError] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const logEndRef = useRef<HTMLDivElement>(null);
  const totalKeywords = inputSets.reduce(
    (count, item) =>
      count +
      item.keywords
        .split("\n")
        .map((k) => k.trim())
        .filter(Boolean).length,
    0,
  );

  const fieldClass =
    "w-full rounded-xl border border-slate-300 bg-slate-50/70 px-3.5 py-2 text-sm text-slate-800 outline-none transition duration-200 placeholder:text-slate-400 focus:border-cyan-500 focus:bg-white focus:ring-4 focus:ring-cyan-100";
  const labelClass = "mb-1.5 block text-sm font-semibold text-slate-700";

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
        if (keywords.length > 10) {
          throw new Error(`Input #${index + 1}: Maximum 10 keywords allowed at a time.`);
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
      console.error("[page] Input validation failed", { error: message });
      return;
    }

    setLoading(true);
    setResults([]);
    setLogs([]);

    try {
      for (const payload of payloads) {
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

        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({})) as { error?: string };
          setError(data.error || "Request failed.");
          setLoading(false);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            const eventMatch = part.match(/^event: (\w+)\ndata:([\s\S]+)$/);
            if (!eventMatch) continue;
            const [, event, dataStr] = eventMatch;
            let parsed: unknown;
            try { parsed = JSON.parse(dataStr); } catch { continue; }

            if (event === "log") {
              const { keyword, message } = parsed as { keyword: string; message: string };
              const line = `[${keyword}] ${message}`;
              setLogs((prev) => {
                const next = [...prev, line];
                setTimeout(() => logEndRef.current?.scrollIntoView({ behavior: "smooth" }), 10);
                return next;
              });
            } else if (event === "result") {
              const result = parsed as RankResult;
              setResults((prev) => [
                ...prev,
                { ...result, inputName: payload.inputName, targetDomain: payload.domain, device: payload.device },
              ]);
            }
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Request failed. Please try again.";
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
    <div className="relative min-h-screen overflow-hidden px-4 py-8 text-slate-900 sm:px-6 lg:px-8">
      <div className="glow-float pointer-events-none absolute -top-28 left-[-80px] h-80 w-80 rounded-full bg-cyan-300/40 blur-3xl" />
      <div className="glow-float pointer-events-none absolute right-[-120px] top-32 h-96 w-96 rounded-full bg-blue-300/35 blur-3xl [animation-delay:2s]" />

      <div className="relative mx-auto w-full max-w-6xl space-y-6">
        <section className="surface-panel fade-up rounded-3xl p-6 sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <p className="mb-3 inline-flex items-center rounded-full border border-cyan-200 bg-cyan-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-cyan-700">
                Live SERP Monitor
              </p>
              <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
                SERP Keyword Rank Checker
              </h1>
              <p className="mt-3 text-sm text-slate-600 sm:text-base">
                Track where your domain ranks on Google across countries,
                cities, and devices in one clean workflow.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:gap-4">
              <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-center shadow-sm">
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Input Sets
                </p>
                <p className="mt-1 text-2xl font-bold text-slate-900">
                  {inputSets.length}
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-center shadow-sm">
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  Keywords
                </p>
                <p className="mt-1 text-2xl font-bold text-slate-900">
                  {totalKeywords}
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="surface-panel fade-up rounded-3xl p-4 sm:p-6">
          <div className="space-y-4">
            {inputSets.map((item, idx) => {
              const selectedCountry =
                countries.find((c) => c.code2 === item.country) || null;
              const states = selectedCountry?.states || [];

              return (
                <div
                  key={item.id}
                  className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:shadow-md sm:p-5"
                >
                  <div className="mb-4 flex items-center justify-between">
                    <h3 className="inline-flex items-center gap-2 text-sm font-semibold text-slate-700">
                      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-cyan-500 to-blue-600 text-xs font-bold text-white">
                        {idx + 1}
                      </span>
                      Input #{idx + 1}
                    </h3>
                  </div>

                  <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                    <div>
                      <label className={labelClass}>
                        Keywords{" "}
                        <span className="font-medium text-slate-400">
                          (one per line, max 10)
                        </span>
                      </label>
                      <textarea
                        className={`${fieldClass} min-h-[120px] resize-y`}
                        placeholder={"gstin search\nincome tax efiling"}
                        value={item.keywords}
                        onChange={(e) =>
                          updateInputSet(item.id, { keywords: e.target.value })
                        }
                      />
                    </div>

                    <div className="space-y-4">
                      <div>
                        <label className={labelClass}>Target Domain</label>
                        <input
                          className={fieldClass}
                          placeholder="taxlegit.com"
                          value={item.domain}
                          onChange={(e) =>
                            updateInputSet(item.id, { domain: e.target.value })
                          }
                        />
                      </div>

                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div>
                          <label className={labelClass}>Country</label>
                          <select
                            className={fieldClass}
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
                          <label className={labelClass}>
                            State / City{" "}
                            <span className="font-medium text-slate-400">
                              (optional)
                            </span>
                          </label>
                          {states.length > 0 ? (
                            <select
                              className={fieldClass}
                              value={item.state}
                              onChange={(e) =>
                                updateInputSet(item.id, {
                                  state: e.target.value,
                                })
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
                              className={fieldClass}
                              placeholder="City or region"
                              value={item.state}
                              onChange={(e) =>
                                updateInputSet(item.id, {
                                  state: e.target.value,
                                })
                              }
                            />
                          )}
                        </div>
                      </div>

                      <div>
                        <label className={labelClass}>Device</label>
                        <div className="flex gap-2.5">
                          {(["desktop", "mobile"] as const).map((d) => (
                            <label key={d} className="cursor-pointer">
                              <input
                                type="radio"
                                name={`device-${item.id}`}
                                value={d}
                                checked={item.device === d}
                                onChange={() =>
                                  updateInputSet(item.id, { device: d })
                                }
                                className="peer sr-only"
                              />
                              <span className="inline-flex items-center rounded-xl border border-slate-300 px-3 py-1.5 text-sm font-semibold capitalize text-slate-600 transition peer-checked:border-transparent peer-checked:bg-gradient-to-r peer-checked:from-cyan-500 peer-checked:to-blue-600 peer-checked:text-white">
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

            {error && (
              <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:items-center">
              <button
                onClick={handleCheck}
                disabled={loading}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-700 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-cyan-600/25 transition hover:from-cyan-500 hover:to-blue-600 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
              >
                {loading && (
                  <svg
                    className="h-4 w-4 animate-spin text-white"
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
        </section>

        {(loading || logs.length > 0) && (
          <section className="surface-panel fade-up rounded-3xl p-4 sm:p-6">
            <h2 className="mb-3 text-sm font-semibold text-slate-700">Live Progress</h2>
            <div className="h-56 overflow-y-auto rounded-xl bg-slate-900 p-4 font-mono text-xs leading-relaxed text-slate-200">
              {logs.map((line, i) => {
                const color = line.includes("✅") ? "text-emerald-400"
                  : line.includes("✗") ? "text-rose-400"
                  : line.includes("⚠") ? "text-amber-400"
                  : line.includes("✓") ? "text-cyan-400"
                  : line.includes("→") ? "text-slate-400"
                  : "text-slate-300";
                return <div key={i} className={color}>{line}</div>;
              })}
              {loading && (
                <div className="mt-1 animate-pulse text-slate-500">▌</div>
              )}
              <div ref={logEndRef} />
            </div>
          </section>
        )}

        {results.length > 0 && (
          <section className="surface-panel fade-up rounded-3xl p-4 sm:p-6">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-lg font-bold text-slate-800 sm:text-xl">
                Results ({results.length} keyword{results.length !== 1 ? "s" : ""}
                {loading ? " — checking..." : ""})
              </h2>
              <button
                onClick={handleExport}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500"
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

            <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
              <table className="w-full min-w-[980px] border-collapse text-left text-sm">
                <thead>
                  <tr className="bg-slate-100 text-xs uppercase tracking-wide text-slate-600">
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
                      className="border-t border-slate-100 transition odd:bg-white even:bg-slate-50/40 hover:bg-cyan-50/40"
                    >
                      <td className="whitespace-nowrap px-3 py-3 text-slate-700">
                        {r.inputName}
                      </td>
                      <td className="max-w-[180px] truncate px-3 py-3 font-semibold text-slate-900">
                        {r.keyword}
                      </td>
                      <td
                        className="max-w-[180px] truncate px-3 py-3 text-slate-700"
                        title={r.targetDomain}
                      >
                        {r.targetDomain}
                      </td>
                      <td className="px-3 py-3 capitalize text-slate-600">
                        {r.device}
                      </td>
                      <td className="px-3 py-3 text-slate-600">
                        {countries.find((c) => c.code2 === r.country)?.name ||
                          r.country}
                      </td>
                      <td className="px-3 py-3 text-slate-600">
                        {r.city || "-"}
                      </td>
                      <td className="px-3 py-3 font-semibold">
                        {r.error ? (
                          <span className="text-amber-600">{r.error}</span>
                        ) : r.yourRank ? (
                          <span className="text-emerald-600">
                            #{r.yourRank}
                          </span>
                        ) : (
                          <span className="text-rose-600">Not in top 100</span>
                        )}
                      </td>
                      <td className="max-w-[190px] px-3 py-3">
                        {r.yourRankedUrl ? (
                          <a
                            href={r.yourRankedUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block truncate text-cyan-700 underline-offset-2 hover:underline"
                            title={r.yourRankedUrl}
                          >
                            {r.yourRankedUrl}
                          </a>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="px-3 py-3 font-semibold text-slate-700">
                        {r.topRankedSite || "-"}
                      </td>
                      <td className="max-w-[190px] px-3 py-3">
                        {r.topRankedUrl ? (
                          <a
                            href={r.topRankedUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block truncate text-cyan-700 underline-offset-2 hover:underline"
                            title={r.topRankedUrl}
                          >
                            {r.topRankedUrl}
                          </a>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3 font-mono text-xs text-slate-500">
                        {formatDate(r.checkedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
