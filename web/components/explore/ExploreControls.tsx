"use client";

export type Tab = "trending" | "new" | "graduated";
export type Sort = "graduated" | "lastTrade" | "mcap" | "volume" | "progress" | "newest" | "oldest";
export type View = "grid" | "list";

export const SORTS: { value: Sort; label: string }[] = [
  { value: "graduated", label: "Recently graduated" },
  { value: "lastTrade", label: "Last trade" },
  { value: "mcap", label: "Market cap" },
  { value: "volume", label: "24h volume" },
  { value: "progress", label: "Bonding progress" },
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
];

const TABS: { value: Tab; label: string; glyph: string }[] = [
  { value: "trending", label: "Trending", glyph: "⚡" },
  { value: "new", label: "New", glyph: "✦" },
  { value: "graduated", label: "Graduated", glyph: "♛" },
];

/** The row above the list: which coins, in what order, as cards or rows. */
export function ExploreControls({
  tab,
  onTab,
  sort,
  onSort,
  view,
  onView,
  query,
  onQuery,
  graduated,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  sort: Sort;
  onSort: (s: Sort) => void;
  view: View;
  onView: (v: View) => void;
  query: string;
  onQuery: (q: string) => void;
  /** how many coins have graduated, shown on that tab */
  graduated: number;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-1 border-b border-white/[0.06]">
        {TABS.map((t) => {
          const active = t.value === tab;
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => onTab(t.value)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors duration-150 ${
                active ? "border-white text-white" : "border-transparent text-zinc-500 hover:text-zinc-200"
              }`}
            >
              <span aria-hidden className="text-xs">
                {t.glyph}
              </span>
              {t.label}
              {t.value === "graduated" && graduated > 0 && <span className="font-mono text-[10px] text-zinc-600">{graduated}</span>}
            </button>
          );
        })}
      </div>
      <div className="flex w-full items-center gap-2 sm:w-auto">
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search name / ticker"
          className="input min-w-0 flex-1 rounded-full px-4 py-1.5 text-sm outline-none placeholder:text-zinc-600 focus:border-white sm:w-44 sm:flex-none"
        />
        <select
          value={sort}
          onChange={(e) => onSort(e.target.value as Sort)}
          className="input rounded-full px-3 py-1.5 text-sm text-zinc-300 outline-none focus:border-white"
          aria-label="Sort"
        >
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <div className="flex rounded-full border border-white/10 p-0.5" role="group" aria-label="View">
          <ViewButton active={view === "grid"} onClick={() => onView("grid")} label="Cards">
            <rect x="2" y="2" width="5" height="5" rx="1" />
            <rect x="9" y="2" width="5" height="5" rx="1" />
            <rect x="2" y="9" width="5" height="5" rx="1" />
            <rect x="9" y="9" width="5" height="5" rx="1" />
          </ViewButton>
          <ViewButton active={view === "list"} onClick={() => onView("list")} label="Rows">
            <rect x="2" y="3" width="12" height="2" rx="1" />
            <rect x="2" y="7" width="12" height="2" rx="1" />
            <rect x="2" y="11" width="12" height="2" rx="1" />
          </ViewButton>
        </div>
      </div>
    </div>
  );
}

function ViewButton({ active, onClick, label, children }: { active: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={label}
      className={`rounded-full p-1.5 transition-colors duration-150 ${active ? "bg-white text-black" : "text-zinc-500 hover:text-white"}`}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
        {children}
      </svg>
      <span className="sr-only">{label}</span>
    </button>
  );
}
