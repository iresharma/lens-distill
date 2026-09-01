// Runs pending Drizzle migrations against DATABASE_URL, creating tables that
// don't exist yet. Plain JS (no tsx) so it can run from the Docker
// standalone image, which only ships production dependencies.
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set");
}

const MAX_ATTEMPTS = 10;
const RETRY_DELAY_MS = 2000;

async function connectWithRetry() {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const pool = new Pool({ connectionString: url });
    try {
      await pool.query("SELECT 1");
      return pool;
    } catch (err) {
      await pool.end().catch(() => {});
      if (attempt === MAX_ATTEMPTS) throw err;
      console.log(
        `[migrate] database not ready (attempt ${attempt}/${MAX_ATTEMPTS}): ${err.message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  throw new Error("unreachable");
}

const pool = await connectWithRetry();
try {
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("[migrate] schema is up to date");
} finally {
  await pool.end().catch(() => {});
}
