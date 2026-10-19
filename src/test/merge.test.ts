import { describe, expect, it } from "vitest";
import { merge3 } from "@/lib/merge";

const base = { cli: [{ id: 1, nom: "Ana" }], pag: [], cfg: { name: "GYC" } };

describe("merge3", () => {
  it("keeps payments added on two devices at the same time", () => {
    const a = { ...base, pag: [{ id: "p1", m: 100 }] };
    const b = { ...base, pag: [{ id: "p2", m: 50 }] };
    const out = merge3(base, a, b)!;
    expect((out.pag as { id: string }[]).map((p) => p.id).sort()).toEqual(["p1", "p2"]);
  });
  it("a client deleted on this device stays deleted", () => {
    const local = { ...base, cli: [] };
    expect(merge3(base, local, base)!.cli).toEqual([]);
  });
  it("an edit from another device is kept when this device didn't touch it", () => {
    const remote = { ...base, cli: [{ id: 1, nom: "Ana María" }] };
    expect(merge3(base, base, remote)!.cli).toEqual([{ id: 1, nom: "Ana María" }]);
  });
});
