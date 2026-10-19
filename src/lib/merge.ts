// Three-way merge of the GYC data object so several devices can edit at once.
// base = last version this device synced, local = this device now, remote = cloud now.
type Obj = Record<string, unknown>;
const key = (x: unknown) =>
  x && typeof x === "object" && "id" in (x as Obj) ? `id:${String((x as Obj)["id"])}` : `j:${JSON.stringify(x)}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function mergeArray(base: unknown[] = [], local: unknown[] = [], remote: unknown[] = []) {
  const b = new Map(base.map((x) => [key(x), x]));
  const l = new Map(local.map((x) => [key(x), x]));
  const r = new Map(remote.map((x) => [key(x), x]));
  const out: unknown[] = [];
  const seen = new Set<string>();
  // keep remote order first, then new local items
  for (const k of [...r.keys(), ...l.keys()]) {
    if (seen.has(k)) continue;
    seen.add(k);
    const inB = b.has(k), inL = l.has(k), inR = r.has(k);
    if (inB && !inL) { if (inR && !same(r.get(k), b.get(k))) out.push(r.get(k)); continue; } // deleted locally
    if (inB && !inR) { if (inL && !same(l.get(k), b.get(k))) out.push(l.get(k)); continue; } // deleted remotely
    if (inL && (!inR || !same(l.get(k), b.get(k)))) out.push(l.get(k));
    else out.push(r.get(k));
  }
  // preserve "newest first" lists (hist) by putting brand-new local entries at the front
  return out;
}

export function merge3(base: Obj | null, local: Obj | null, remote: Obj | null): Obj | null {
  if (!remote) return local;
  if (!local) return remote;
  const b = base ?? {};
  const out: Obj = {};
  for (const k of new Set([...Object.keys(remote), ...Object.keys(local)])) {
    const bv = b[k], lv = local[k], rv = remote[k];
    if (Array.isArray(lv) || Array.isArray(rv)) {
      out[k] = mergeArray(bv as unknown[], lv as unknown[], rv as unknown[]);
      if (k === "hist") {
        const merged = out[k] as unknown[];
        const fresh = merged.filter((x) => !(rv as unknown[] | undefined)?.some((y) => same(x, y)));
        out[k] = [...fresh, ...merged.filter((x) => !fresh.includes(x))];
      }
    } else if (lv && rv && typeof lv === "object" && typeof rv === "object") {
      out[k] = merge3((bv as Obj) ?? null, lv as Obj, rv as Obj);
    } else {
      out[k] = same(lv, bv) ? rv : lv;
    }
  }
  return out;
}
