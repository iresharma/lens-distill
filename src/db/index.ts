import { neon, neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle as drizzleHttp } from "drizzle-orm/neon-http";
import { drizzle as drizzlePool } from "drizzle-orm/neon-serverless";
import ws from "ws";
import * as schema from "./schema";

neonConfig.webSocketConstructor = ws;

type HttpDb = ReturnType<typeof drizzleHttp>;

function createDb(): HttpDb {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  return drizzleHttp(neon(url), { schema });
}

const globalForDb = globalThis as unknown as {
  db?: HttpDb;
};

function getDb(): HttpDb {
  if (!globalForDb.db) {
    globalForDb.db = createDb();
  }
  return globalForDb.db;
}

export const db: HttpDb = new Proxy({} as HttpDb, {
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
  return { pool, wdb: drizzlePool(pool, { schema }) };
}

export type WorkerDb = ReturnType<typeof makeWorkerDb>["wdb"];
