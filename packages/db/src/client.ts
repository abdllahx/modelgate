import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import pg from "pg";
import * as schema from "./schema.js";

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

// Resolves from both src/ and dist/: each sits one level below the package root.
const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

export interface Connection {
  db: Database;
  driver: "postgres" | "pglite";
  close: () => Promise<void>;
}

/**
 * Connects and applies pending migrations. With a URL (Render Postgres) it uses
 * node-postgres; without one it runs embedded PGlite, in memory or in `dataDir`,
 * so local development and tests need no database server.
 */
export async function connect(options: { url?: string | undefined; dataDir?: string | undefined } = {}): Promise<Connection> {
  if (options.url) {
    const pool = new pg.Pool({ connectionString: options.url, max: 5 });
    const db = drizzlePostgres(pool, { schema });
    await migratePostgres(db, { migrationsFolder: MIGRATIONS });
    return { db, driver: "postgres", close: () => pool.end() };
  }
  // PGlite creates its own folder but not missing parents (a fresh MODELGATE_HOME).
  if (options.dataDir) mkdirSync(options.dataDir, { recursive: true });
  const client = new PGlite(options.dataDir);
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder: MIGRATIONS });
  return { db, driver: "pglite", close: () => client.close() };
}
