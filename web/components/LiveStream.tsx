"use client";

import { safeLink } from "@/lib/sanitize";

/** Embedded livestream player. Only allowlisted providers are embedded
 *  (YouTube / Twitch); anything else renders as an outbound LIVE link. */
export function LiveStream({ url }: { url: string }) {
  const safe = safeLink(url);
  if (!safe) return null;

  const embed = toEmbed(safe);

  return (
    <div className="rounded-xl border border-white/10 bg-black overflow-hidden">
      <div className="px-4 py-2.5 border-b border-white/[0.06] flex items-center gap-2">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-60" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-white" />
        </span>
        <span className="font-mono text-[10px] tracking-widest uppercase text-zinc-300">
          Live
        </span>
        <a
          href={safe}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto font-mono text-[10px] tracking-widest uppercase text-zinc-500 hover:text-white underline"
        >
          Open ↗
        </a>
      </div>
      {embed ? (
        <div className="aspect-video">
          <iframe
            src={embed}
            className="w-full h-full"
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
          />
        </div>
      ) : (
        <a
          href={safe}
          target="_blank"
          rel="noopener noreferrer"
          className="block px-4 py-6 text-sm text-zinc-300 hover:text-white"
        >
          The creator is live — watch the stream ↗
        </a>
      )}
    </div>
  );
}

function toEmbed(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");

    // YouTube: watch?v=ID, youtu.be/ID, /live/ID, /shorts/ID
    if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be") {
      let id = "";
      if (host === "youtu.be") id = u.pathname.slice(1).split("/")[0];
      else if (u.searchParams.get("v")) id = u.searchParams.get("v")!;
      else {
        const m = u.pathname.match(/^\/(live|shorts|embed)\/([\w-]+)/);
        if (m) id = m[2];
      }
      if (/^[\w-]{6,}$/.test(id))
        return `https://www.youtube-nocookie.com/embed/${id}?autoplay=0`;
    }

    // Twitch channel or video
    if (host === "twitch.tv") {
      const parent = typeof window !== "undefined" ? window.location.hostname : "";
      if (!parent) return null;
      const seg = u.pathname.slice(1).split("/");
      if (seg[0] === "videos" && /^\d+$/.test(seg[1] ?? ""))
        return `https://player.twitch.tv/?video=${seg[1]}&parent=${parent}&autoplay=false`;
      if (/^\w{3,25}$/.test(seg[0] ?? ""))
        return `https://player.twitch.tv/?channel=${seg[0]}&parent=${parent}&autoplay=false`;
    }
  } catch {
    /* not a URL */
  }
  return null;
}
