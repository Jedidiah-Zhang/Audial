import { drizzle } from "npm:drizzle-orm/postgres-js";
import postgres from "npm:postgres";
import * as schema from "./schema.ts";

const connectionString = Deno.env.get("DATABASE_URL");
if (!connectionString) {
  throw new Error("DATABASE_URL must be set");
}

const queryClient = postgres(connectionString);
export const sql = queryClient;
export const db = drizzle(queryClient, { schema });
export * from "./schema.ts";
