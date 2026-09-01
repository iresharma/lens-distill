import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

function createDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  return drizzle(new Pool({ connectionString: url }), { schema });
}

const globalForDb = globalThis as unknown as {
  db?: Db;
};

function getDb(): Db {
  if (!globalForDb.db) {
    globalForDb.db = createDb();
  }
  return globalForDb.db;
}

export const db: Db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    const real = getDb();
    const value = Reflect.get(real, prop, receiver);
    return typeof value === "function" ? value.bind(real) : value;
  },
});

export function makeWorkerDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  const pool = new Pool({ connectionString: url });
  return { pool, wdb: drizzle(pool, { schema }) };
}

export type WorkerDb = ReturnType<typeof makeWorkerDb>["wdb"];
