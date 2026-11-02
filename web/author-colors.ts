const assigned = new Map<string, number>();
export function authorColors(author: string) {
  const key = author.toLowerCase();
  let hue = assigned.get(key);
  if (hue == null) {
    let hash = 2166136261;
    for (const char of key) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    hue = hash % 360;
    for (let attempt = 0; attempt < 16; attempt++) {
      const nearby = [...assigned.values()].some(
        (used) => Math.min(Math.abs(used - hue!), 360 - Math.abs(used - hue!)) < 24,
      );
      if (!nearby) break;
      hue = (hue + 47) % 360;
    }
    assigned.set(key, hue);
  }
  // The shades for the hue are defined in the stylesheet, separately for each theme.
  return { '--author-hue': hue };
}
