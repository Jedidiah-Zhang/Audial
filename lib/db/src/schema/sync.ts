import {
  pgTable,
  text,
  integer,
  jsonb,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

// Cross-device sync schema for Audial.
//
// `userId` is the Clerk userId (e.g. "user_2abc..."). Rows are scoped by
// userId; routes resolve userId from the verified Clerk JWT, never from
// client-supplied headers. The "id" column on per-record tables is the
// client-generated id (the same id that the client uses in AsyncStorage)
// so a row written from device A and re-pushed from device B collapses
// into one row instead of duplicating.

export const usersTable = pgTable("users", {
  id: text("id").primaryKey(), // Clerk userId
  tier: text("tier").notNull().default("free"), // "free" | "pro"
  upgradedAt: timestamp("upgraded_at", { withTimezone: true }),
  // Interface language code (e.g. "en-US", "zh"). Captured at sign-up
  // time so the language a brand-new user picked on the auth screen is
  // remembered server-side and re-applied when they sign in on another
  // device. NULL means no language has been recorded for this account
  // yet (in which case the device's local nativeLanguage stays in
  // effect). Only the user's own routes ever read or write this.
  nativeLanguage: text("native_language"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
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
    // Original client createdAt (epoch ms). Lets sync return rows in the
    // same order the client originally saw them.
    clientCreatedAt: integer("client_created_at").notNull().default(0),
    // Last time the user tapped this text in the article list. Used to
    // sort articles by recency of access; null means never tapped.
    lastClickedAt: integer("last_clicked_at"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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
    mode: text("mode").notNull(), // shadowing | dictation | recitation | listening
    stage: integer("stage").notNull(),
    score: integer("score").notNull(),
    feedback: text("feedback").notNull().default(""),
    details: jsonb("details"),
    clientCreatedAt: integer("client_created_at").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.textId] })],
);

export const generationQuotaTable = pgTable(
  "generation_quota",
  {
    userId: text("user_id").notNull(),
    date: text("date").notNull(), // YYYY-MM-DD bucket (Asia/Shanghai 04:00 rollover)
    count: integer("count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.date] })],
);

export type UserRow = typeof usersTable.$inferSelect;
export type TextRow = typeof textsTable.$inferSelect;
export type ResultRow = typeof resultsTable.$inferSelect;
export type ProgressRow = typeof progressTable.$inferSelect;
export type GenerationQuotaRow = typeof generationQuotaTable.$inferSelect;
