import { Client } from "pg";

const TABLES_IN_DELETE_ORDER = [
  "results",
  "progress",
  "generation_quota",
  "texts",
  "users",
] as const;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const isProd = (process.env.REPLIT_DEPLOYMENT ?? "") === "1";
  if (isProd && process.argv[2] !== "--yes-prod") {
    console.error(
      "Refusing to run against production. Re-invoke with --yes-prod after explicit owner approval.",
    );
    process.exit(1);
  }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const before: Record<string, number> = {};
    for (const t of TABLES_IN_DELETE_ORDER) {
      const r = await client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${t}`);
      before[t] = Number(r.rows[0]?.n ?? "0");
    }
    console.log("BEFORE:", before);

    await client.query("BEGIN");
    for (const t of TABLES_IN_DELETE_ORDER) {
      await client.query(`DELETE FROM ${t}`);
    }
    await client.query("COMMIT");

    const after: Record<string, number> = {};
    for (const t of TABLES_IN_DELETE_ORDER) {
      const r = await client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${t}`);
      after[t] = Number(r.rows[0]?.n ?? "0");
    }
    console.log("AFTER: ", after);
    console.log(
      "NOTE: Clerk-side accounts are NOT touched by this script. Remove them in the Clerk Dashboard if a true relaunch is desired.",
    );
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
