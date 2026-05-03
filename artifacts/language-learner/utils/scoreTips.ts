import type { LearningMode } from "@/types";

export type ScoreTipIcon =
  | "accuracy"
  | "confidence"
  | "pace"
  | "prosody"
  | "hint"
  | "coverage";

export interface ScoreTip {
  id: string;
  icon: ScoreTipIcon;
  reasonKey: string;
  actionKey: string;
  params?: Record<string, string | number>;
}

export interface ScoreTipsInput {
  mode: LearningMode;
  metrics: {
    accuracy?: number | null;
    confidence?: number | null;
    pace?: number | null;
    prosody?: number | null;
    prosodyAvailable?: boolean;
    coverage?: number | null;
    hintsUsed?: number;
    hintScoreDeduction?: number;
  };
}

export interface ScoreTipsResult {
  tips: ScoreTip[];
  encouragement: boolean;
}

const HIGH_THRESHOLD = 85;
const SEVERE_THRESHOLD = 60;
const MAX_DIMENSION_TIPS = 3;
const COVERAGE_LOW_THRESHOLD = 75;

const DIMENSION_WEIGHTS: Record<
  "accuracy" | "confidence" | "pace" | "prosody",
  number
> = {
  accuracy: 0.4,
  confidence: 0.25,
  prosody: 0.2,
  pace: 0.15,
};

type Dimension = keyof typeof DIMENSION_WEIGHTS;

function severityFor(score: number): "severe" | "mild" | null {
  if (score >= HIGH_THRESHOLD) return null;
  if (score < SEVERE_THRESHOLD) return "severe";
  return "mild";
}

function dimensionTip(
  dim: Dimension,
  severity: "severe" | "mild",
): ScoreTip {
  return {
    id: `${dim}.${severity}`,
    icon: dim,
    reasonKey: `tips.${dim}.${severity}.reason`,
    actionKey: `tips.${dim}.${severity}.action`,
  };
}

export function buildScoreTips(input: ScoreTipsInput): ScoreTipsResult {
  const { mode, metrics } = input;

  const candidates: { dim: Dimension; score: number; severity: "severe" | "mild" }[] = [];
  const considerDim = (dim: Dimension, raw: number | null | undefined) => {
    if (typeof raw !== "number" || !Number.isFinite(raw)) return;
    const s = severityFor(raw);
    if (!s) return;
    candidates.push({ dim, score: raw, severity: s });
  };

  considerDim("accuracy", metrics.accuracy);
  considerDim("confidence", metrics.confidence);
  considerDim("pace", metrics.pace);
  if (metrics.prosodyAvailable !== false) {
    considerDim("prosody", metrics.prosody ?? undefined);
  }

  candidates.sort((a, b) => {
    const pa = (HIGH_THRESHOLD - a.score) * DIMENSION_WEIGHTS[a.dim];
    const pb = (HIGH_THRESHOLD - b.score) * DIMENSION_WEIGHTS[b.dim];
    return pb - pa;
  });

  const tips: ScoreTip[] = candidates
    .slice(0, MAX_DIMENSION_TIPS)
    .map((c) => dimensionTip(c.dim, c.severity));

  // Extra rules — appended on top of the 3-cap, max +1 per rule.
  if (mode === "dictation" && (metrics.hintsUsed ?? 0) > 0) {
    const count = metrics.hintsUsed ?? 0;
    const delta = metrics.hintScoreDeduction ?? count * 10;
    tips.push({
      id: "hint",
      icon: "hint",
      reasonKey: "tips.hint.reason",
      actionKey: "tips.hint.action",
      params: { count, delta },
    });
  }

  if (mode === "recitation" && typeof metrics.coverage === "number") {
    if (metrics.coverage < COVERAGE_LOW_THRESHOLD) {
      tips.push({
        id: "coverage",
        icon: "coverage",
        reasonKey: "tips.coverage.reason",
        actionKey: "tips.coverage.action",
        params: { coverage: Math.round(metrics.coverage) },
      });
    }
  }

  return { tips, encouragement: tips.length === 0 };
}
