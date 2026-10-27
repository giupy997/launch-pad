/** A text field shown after a fixed prefix (x.com/, t.me/): the creator types
 *  the handle, the caller turns it into a link with prefixed(). */
export function PrefixInput({
  base,
  value,
  onChange,
}: {
  base: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center rounded-lg input focus-within:border-white">
      <span className="pl-3 text-zinc-600 text-sm whitespace-nowrap">{base}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="handle"
        className="w-full bg-transparent px-1.5 py-2 text-sm outline-none placeholder:text-zinc-700 min-w-0"
      />
    </div>
  );
}
