import { describe, it, expect, vi } from "vitest";

// `cloudSync.ts` imports AsyncStorage and the generated API client at the
// top of the file. The pure functions we want to test (`mergeSnapshot`,
// `buildPushFromQueue`) don't actually call into either of those, but
// the imports still need to resolve under jsdom — so we stub them.
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    multiRemove: vi.fn(),
  },
}));

vi.mock("../api-client", () => ({
  getSyncSnapshot: vi.fn(),
  pushSync: vi.fn(),
  setSubscription: vi.fn(),
}));

import {
  buildPushFromQueue,
  mergeSnapshot,
  type LocalSnapshot,
  type PendingQueue,
} from "@/utils/cloudSync";
import type { LearningText, SessionResult, UserProgress } from "@/types";
import { STAGES } from "@/types";

// =====================================================================
// Fixture helpers — keep tests terse and intent-focused. Defaults match
// the schema's runtime shape (every field present so tests can override
// only the ones that matter).
// =====================================================================

function makeText(over: Partial<LearningText> & { id: string }): LearningText {
  return {
    title: "Untitled",
    text: "hello",
    translation: "",
    vocabulary: [],
    topic: "",
    difficulty: "intermediate",
    targetLanguage: "en-US",
    nativeLanguage: "en-US",
    contentType: "general",
    createdAt: 1_000,
    ...over,
  } as LearningText;
}

function makeResult(
  over: Partial<SessionResult> & { id: string; textId: string },
): SessionResult {
  return {
    mode: "shadowing",
    stage: 0,
    score: 80,
    feedback: "",
    createdAt: 1_000,
    ...over,
  } as SessionResult;
}

function makeProgress(textId: string, over: Partial<UserProgress> = {}): UserProgress {
  return {
    textId,
    stageBests: STAGES.map(() => 0),
    stagePassed: STAGES.map(() => false),
    lastStudied: 0,
    totalSessions: 0,
    shadowingBest: 0,
    dictationBest: 0,
    recitationBest: 0,
    ...over,
  };
}

function emptyLocal(): LocalSnapshot {
  return { texts: [], results: [], progress: {} };
}

function emptyCloud() {
  return {
    texts: [],
    results: [],
    progress: [],
    subscription: { tier: "free" as const, upgradedAt: null },
    quota: {
      date: "2026-01-01",
      count: 0,
      limit: 3,
      remaining: 3,
      tier: "free" as const,
    },
    settings: { nativeLanguage: null },
  };
}

// =====================================================================
// mergeSnapshot
// =====================================================================

describe("mergeSnapshot", () => {
  it("returns empty merged + empty toPush when both sides are empty", () => {
    const { merged, toPush } = mergeSnapshot(emptyLocal(), emptyCloud());
    expect(merged.texts).toEqual([]);
    expect(merged.results).toEqual([]);
    expect(merged.progress).toEqual({});
    expect(merged.subscription.tier).toBe("free");
    expect(toPush.texts).toEqual([]);
    expect(toPush.results).toEqual([]);
    expect(toPush.progress).toEqual([]);
  });

  it("cloud-wins on text id collision (keeps cloud version, drops local)", () => {
    const local = {
      ...emptyLocal(),
      texts: [makeText({ id: "t1", title: "LOCAL", createdAt: 100 })],
    };
    const cloud = {
      ...emptyCloud(),
      texts: [
        {
          id: "t1",
          title: "CLOUD",
          text: "hi",
          translation: "",
          vocabulary: [],
          topic: "",
          difficulty: "intermediate",
          targetLanguage: "en-US",
          nativeLanguage: "en-US",
          contentType: "general",
          createdAt: 200,
        },
      ],
    };

    const { merged, toPush } = mergeSnapshot(local, cloud);

    expect(merged.texts).toHaveLength(1);
    expect(merged.texts[0].title).toBe("CLOUD");
    // Colliding id MUST NOT be re-pushed — cloud already has the row.
    expect(toPush.texts).toEqual([]);
  });

  it("includes local-only texts in toPush and merges them into the result", () => {
    const local = {
      ...emptyLocal(),
      texts: [
        makeText({ id: "local1", title: "Local Only", createdAt: 500 }),
        makeText({ id: "shared", title: "Local Shared", createdAt: 100 }),
      ],
    };
    const cloud = {
      ...emptyCloud(),
      texts: [
        {
          id: "shared",
          title: "Cloud Shared",
          text: "x",
          translation: "",
          vocabulary: [],
          topic: "",
          difficulty: "intermediate",
          targetLanguage: "en-US",
          nativeLanguage: "en-US",
          contentType: "general",
          createdAt: 800,
        },
      ],
    };

    const { merged, toPush } = mergeSnapshot(local, cloud);

    // Two merged: cloud "shared" (cloud-wins) + local-only "local1".
    const ids = merged.texts.map((t) => t.id);
    expect(ids).toContain("shared");
    expect(ids).toContain("local1");
    expect(merged.texts.find((t) => t.id === "shared")?.title).toBe(
      "Cloud Shared",
    );

    // Sorted by createdAt desc — cloud "shared" (800) comes before local
    // "local1" (500).
    expect(merged.texts[0].id).toBe("shared");
    expect(merged.texts[1].id).toBe("local1");

    // Only the local-only id should land in toPush.
    expect(toPush.texts?.map((t) => t.id)).toEqual(["local1"]);
  });

  it("cloud-wins on result id collision and pushes only local-only results", () => {
    const local = {
      ...emptyLocal(),
      results: [
        makeResult({ id: "r1", textId: "t1", score: 50 }),
        makeResult({ id: "r2", textId: "t1", score: 70 }),
      ],
    };
    const cloud = {
      ...emptyCloud(),
      results: [
        {
          id: "r1",
          textId: "t1",
          mode: "shadowing",
          stage: 0,
          score: 99,
          feedback: "",
          createdAt: 1_000,
          details: null,
        },
      ],
    };

    const { merged, toPush } = mergeSnapshot(local, cloud);

    const r1 = merged.results.find((r) => r.id === "r1");
    expect(r1?.score).toBe(99); // cloud wins
    expect(merged.results.find((r) => r.id === "r2")?.score).toBe(70);
    expect(toPush.results?.map((r) => r.id)).toEqual(["r2"]);
  });

  it("caps merged results at 200 (newest first by createdAt)", () => {
    const cloudResults = Array.from({ length: 150 }, (_, i) => ({
      id: `cloud${i}`,
      textId: "t1",
      mode: "shadowing",
      stage: 0,
      score: 80,
      feedback: "",
      createdAt: 10_000 + i, // newer than local
      details: null,
    }));
    const localResults = Array.from({ length: 100 }, (_, i) =>
      makeResult({ id: `local${i}`, textId: "t1", createdAt: i }),
    );
    const { merged } = mergeSnapshot(
      { ...emptyLocal(), results: localResults },
      { ...emptyCloud(), results: cloudResults },
    );
    expect(merged.results).toHaveLength(200);
    // Newest cloud results should come first.
    expect(merged.results[0].id).toBe(`cloud149`);
  });

  it("merges progress with cloud-wins on textId collision", () => {
    const local = {
      ...emptyLocal(),
      progress: {
        t1: makeProgress("t1", { totalSessions: 1, shadowingBest: 50 }),
        t2: makeProgress("t2", { totalSessions: 5, shadowingBest: 88 }),
      },
    };
    const cloud = {
      ...emptyCloud(),
      progress: [
        {
          textId: "t1",
          stageBests: [10, 20, 30],
          stagePassed: [true, false, false],
          lastStudied: 9_999,
          totalSessions: 9,
          shadowingBest: 90,
          dictationBest: 85,
          recitationBest: 80,
        },
      ],
    };

    const { merged, toPush } = mergeSnapshot(local, cloud);

    // t1 wins from cloud; t2 is local-only and survives.
    expect(merged.progress.t1.shadowingBest).toBe(90);
    expect(merged.progress.t1.totalSessions).toBe(9);
    expect(merged.progress.t2.totalSessions).toBe(5);

    // toPush carries only the local-only textId.
    expect(toPush.progress?.map((p) => p.textId)).toEqual(["t2"]);
  });

  it("maps subscription tier 'pro' through and any other value to 'free'", () => {
    const proCloud = {
      ...emptyCloud(),
      subscription: { tier: "pro" as const, upgradedAt: 12345 },
    };
    const garbageCloud = {
      ...emptyCloud(),
      // The merge function defensively coerces unknown tier values to "free".
      subscription: { tier: "anything-else" as never, upgradedAt: null },
    };

    expect(mergeSnapshot(emptyLocal(), proCloud).merged.subscription).toEqual({
      tier: "pro",
      upgradedAt: 12345,
    });
    expect(
      mergeSnapshot(emptyLocal(), garbageCloud).merged.subscription.tier,
    ).toBe("free");
  });
});

// =====================================================================
// buildPushFromQueue
// =====================================================================

describe("buildPushFromQueue", () => {
  const local: LocalSnapshot = {
    texts: [
      makeText({ id: "t1", title: "T1" }),
      makeText({ id: "t2", title: "T2" }),
    ],
    results: [
      makeResult({ id: "r1", textId: "t1" }),
      makeResult({ id: "r2", textId: "t2" }),
    ],
    progress: {
      t1: makeProgress("t1", { totalSessions: 3 }),
      t2: makeProgress("t2", { totalSessions: 7 }),
    },
  };

  it("returns just deletedTextIds when the queue carries only deletions", () => {
    const queue: PendingQueue = {
      textIds: [],
      deletedTextIds: ["x", "y"],
      resultIds: [],
      progressTextIds: [],
    };
    const payload = buildPushFromQueue(local, queue);
    expect(payload.texts).toEqual([]);
    expect(payload.results).toEqual([]);
    expect(payload.progress).toEqual([]);
    expect(payload.deletedTextIds).toEqual(["x", "y"]);
  });

  it("includes only the requested ids and drops ones not present locally", () => {
    const queue: PendingQueue = {
      textIds: ["t1", "missing"],
      deletedTextIds: [],
      resultIds: ["r2", "ghost"],
      progressTextIds: ["t2", "phantom"],
    };
    const payload = buildPushFromQueue(local, queue);
    expect(payload.texts?.map((t) => t.id)).toEqual(["t1"]);
    expect(payload.results?.map((r) => r.id)).toEqual(["r2"]);
    expect(payload.progress?.map((p) => p.textId)).toEqual(["t2"]);
  });

  it("uses the latest local value for each id (not whatever was there when queued)", () => {
    // Edits made locally between enqueue and flush must show up in the
    // outgoing payload — that's the whole point of pushing-by-id, not
    // by snapshotting the row at enqueue time.
    const updatedLocal: LocalSnapshot = {
      ...local,
      texts: [
        makeText({ id: "t1", title: "EDITED LATER" }),
        local.texts[1],
      ],
    };
    const queue: PendingQueue = {
      textIds: ["t1"],
      deletedTextIds: [],
      resultIds: [],
      progressTextIds: [],
    };
    const payload = buildPushFromQueue(updatedLocal, queue);
    expect(payload.texts?.[0]?.title).toBe("EDITED LATER");
  });
});
