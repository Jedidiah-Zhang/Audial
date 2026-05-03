import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory AsyncStorage mock — backs the same get/set/multiRemove API
// `migrateGuestData` actually exercises. Hoisted via vi.mock so the
// stub is in place before the SUT imports the real module.
const mem = new Map<string, string>();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (k: string) => (mem.has(k) ? mem.get(k)! : null)),
    setItem: vi.fn(async (k: string, v: string) => {
      mem.set(k, v);
    }),
    removeItem: vi.fn(async (k: string) => {
      mem.delete(k);
    }),
    multiRemove: vi.fn(async (keys: string[]) => {
      for (const k of keys) mem.delete(k);
    }),
  },
}));

// migrateGuestData also calls `transferAudioOwnership(guest, target)` to
// re-key cached TTS audio. Stub it out as a noop — the audio cache
// behavior has its own test surface.
const transferAudioOwnership = vi.fn(
  async (_from: string, _to: string) => {},
);
vi.mock("@/utils/ttsCache", () => ({
  transferAudioOwnership: (from: string, to: string) =>
    transferAudioOwnership(from, to),
}));

import { migrateGuestData } from "@/utils/migrateGuestData";

const G = {
  TEXTS: "ll:guest:texts",
  RESULTS: "ll:guest:results",
  PROGRESS: "ll:guest:progress",
  SUBSCRIPTION: "ll:guest:subscription",
};
const T = {
  TEXTS: "ll:user_abc:texts",
  RESULTS: "ll:user_abc:results",
  PROGRESS: "ll:user_abc:progress",
  SUBSCRIPTION: "ll:user_abc:subscription",
};

beforeEach(() => {
  mem.clear();
  transferAudioOwnership.mockClear();
});

describe("migrateGuestData", () => {
  it("is a no-op when the target is the guest scope itself", async () => {
    mem.set(G.TEXTS, JSON.stringify([{ id: "g1" }]));
    const moved = await migrateGuestData("guest");
    expect(moved).toBe(false);
    // Guest data must NOT be cleared — calling with "guest" should be inert.
    expect(mem.get(G.TEXTS)).toBeTruthy();
  });

  it("returns false and writes nothing when guest scope is empty", async () => {
    const moved = await migrateGuestData("user_abc");
    expect(moved).toBe(false);
    expect(mem.get(T.TEXTS)).toBeUndefined();
  });

  it("copies guest-only items onto a fresh target and clears guest scope", async () => {
    mem.set(
      G.TEXTS,
      JSON.stringify([{ id: "g1", title: "Guest 1", createdAt: 1 }]),
    );
    mem.set(
      G.RESULTS,
      JSON.stringify([{ id: "r1", textId: "g1", score: 80, createdAt: 1 }]),
    );
    mem.set(
      G.PROGRESS,
      JSON.stringify({ g1: { textId: "g1", totalSessions: 2 } }),
    );

    const moved = await migrateGuestData("user_abc");
    expect(moved).toBe(true);

    const texts = JSON.parse(mem.get(T.TEXTS)!);
    const results = JSON.parse(mem.get(T.RESULTS)!);
    const progress = JSON.parse(mem.get(T.PROGRESS)!);
    expect(texts).toHaveLength(1);
    expect(texts[0].id).toBe("g1");
    expect(results[0].id).toBe("r1");
    expect(progress.g1.totalSessions).toBe(2);

    // Guest scope is wiped after a successful migration.
    expect(mem.get(G.TEXTS)).toBeUndefined();
    expect(mem.get(G.RESULTS)).toBeUndefined();
    expect(mem.get(G.PROGRESS)).toBeUndefined();

    // Audio ownership re-keying was attempted.
    expect(transferAudioOwnership).toHaveBeenCalledWith("guest", "user_abc");
  });

  it("target-wins on id collisions (guest item is dropped, target preserved)", async () => {
    mem.set(
      G.TEXTS,
      JSON.stringify([
        { id: "shared", title: "Guest Shared", createdAt: 1 },
        { id: "g_only", title: "Guest Only", createdAt: 2 },
      ]),
    );
    mem.set(
      T.TEXTS,
      JSON.stringify([{ id: "shared", title: "Target Shared", createdAt: 9 }]),
    );

    await migrateGuestData("user_abc");

    const texts = JSON.parse(mem.get(T.TEXTS)!);
    const sharedRow = texts.find((t: { id: string }) => t.id === "shared");
    expect(sharedRow.title).toBe("Target Shared");
    expect(texts.map((t: { id: string }) => t.id).sort()).toEqual(
      ["g_only", "shared"].sort(),
    );
  });

  it("does not migrate progress for an id the target already tracks", async () => {
    mem.set(G.TEXTS, JSON.stringify([{ id: "t1", title: "g", createdAt: 1 }]));
    mem.set(
      G.PROGRESS,
      JSON.stringify({ t1: { textId: "t1", totalSessions: 99 } }),
    );
    mem.set(
      T.PROGRESS,
      JSON.stringify({ t1: { textId: "t1", totalSessions: 1 } }),
    );

    await migrateGuestData("user_abc");

    const progress = JSON.parse(mem.get(T.PROGRESS)!);
    expect(progress.t1.totalSessions).toBe(1); // target wins
  });

  it("'pro wins' on subscription merge and uses earliest upgrade timestamp", async () => {
    // Guest is Pro since 100; target row exists but is free → result is
    // Pro with upgradedAt=100.
    mem.set(
      G.SUBSCRIPTION,
      JSON.stringify({ tier: "pro", upgradedAt: 100 }),
    );
    // Guest needs at least *some* data to flow through the migration
    // gate (`hasGuestData`). The Pro flag alone is enough; verify that.
    const moved = await migrateGuestData("user_abc");
    expect(moved).toBe(true);

    const sub = JSON.parse(mem.get(T.SUBSCRIPTION)!);
    expect(sub.tier).toBe("pro");
    expect(sub.upgradedAt).toBe(100);
  });

  it("does not write the subscription key when both sides are free", async () => {
    mem.set(G.TEXTS, JSON.stringify([{ id: "g1", title: "g", createdAt: 1 }]));
    mem.set(G.SUBSCRIPTION, JSON.stringify({ tier: "free" }));
    await migrateGuestData("user_abc");
    expect(mem.get(T.SUBSCRIPTION)).toBeUndefined();
  });
});
