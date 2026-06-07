import {
  pgTable,
  text,
  integer,
  bigint,
  jsonb,
  timestamp,
  primaryKey,
  index,
} from "npm:drizzle-orm/pg-core";

// Cross-device sync schema for Audial.
//
// `userId` is the Clerk userId (e.g. "user_2abc..."). Rows are scoped by
// userId; routes resolve userId from the verified Clerk JWT, never from
// client-supplied headers.

export const usersTable = pgTable("users", {
  id: text("id").primaryKey(),
  tier: text("tier").notNull().default("free"),
  upgradedAt: timestamp("upgraded_at", { withTimezone: true }),
  nativeLanguage: text("native_language"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const textsTable = pgTable(
  "texts",
  {
    id: text("id").notNull(),
    userId: text("user_id").notNull(),
    title: text("title").notNull(),
    text: text("text").notNull(),
    translation: text("translation").notNull().default(""),
    vocabulary: jsonb("vocabulary").notNull().default([]),
    topic: text("topic").notNull().default(""),
    difficulty: text("difficulty").notNull().default("intermediate"),
    targetLanguage: text("target_language").notNull().default("en-US"),
    nativeLanguage: text("native_language").notNull().default("en-US"),
    contentType: text("content_type"),
    clientCreatedAt: bigint("client_created_at", { mode: "number" }).notNull().default(0),
    lastClickedAt: bigint("last_clicked_at", { mode: "number" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index("texts_user_idx").on(t.userId),
  ],
);

export const resultsTable = pgTable(
  "results",
  {
    id: text("id").notNull(),
    userId: text("user_id").notNull(),
    textId: text("text_id").notNull(),
    mode: text("mode").notNull(),
    stage: integer("stage").notNull(),
    score: integer("score").notNull(),
    feedback: text("feedback").notNull().default(""),
    details: jsonb("details"),
    clientCreatedAt: integer("client_created_at").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    index("results_user_idx").on(t.userId),
  ],
);

export const progressTable = pgTable(
  "progress",
  {
    userId: text("user_id").notNull(),
    textId: text("text_id").notNull(),
    stageBests: jsonb("stage_bests").notNull().default([]),
    stagePassed: jsonb("stage_passed").notNull().default([]),
    lastStudied: integer("last_studied").notNull().default(0),
    totalSessions: integer("total_sessions").notNull().default(0),
    shadowingBest: integer("shadowing_best").notNull().default(0),
    dictationBest: integer("dictation_best").notNull().default(0),
    recitationBest: integer("recitation_best").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.textId] })],
);

export const generationQuotaTable = pgTable(
  "generation_quota",
  {
    userId: text("user_id").notNull(),
    date: text("date").notNull(),
    count: integer("count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.date] })],
);

export type UserRow = typeof usersTable.$inferSelect;
export type TextRow = typeof textsTable.$inferSelect;
export type ResultRow = typeof resultsTable.$inferSelect;
export type ProgressRow = typeof progressTable.$inferSelect;
export type GenerationQuotaRow = typeof generationQuotaTable.$inferSelect;
