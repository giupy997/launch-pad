/** Shown the instant a coin page is opened, while its shell comes from the
 *  server (a coin's page is rendered on its first visit, then cached): the
 *  same skeleton the page shows while it reads the chain, so the wait reads
 *  as one. Every other page is static and needs no such file. */
export default function Loading() {
  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_360px] animate-pulse">
      <div className="space-y-6">
        <div className="flex gap-4">
          <div className="w-[72px] h-[72px] rounded-lg bg-zinc-900" />
          <div className="space-y-2 pt-2">
            <div className="h-5 w-40 rounded bg-white/[0.06]" />
            <div className="h-3 w-24 rounded bg-white/[0.06]" />
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 rounded-lg bg-zinc-900" />
          ))}
        </div>
        <div className="h-40 rounded-xl bg-zinc-900" />
      </div>
      <div className="h-64 rounded-xl bg-zinc-900" />
    </div>
  );
}
