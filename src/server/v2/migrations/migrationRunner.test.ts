import { describe, expect, it } from "vitest";
import {
  MIGRATIONS,
  SCHEMA_BACKWARDS_COMPATIBLE,
  getLatestMigrationVersion,
} from "./migrationRunner";
import { DATABASE_SCHEMA_VERSION, PRODUCT_VERSION } from "../../../version";

/** -1 / 0 / 1, numeric per component. */
function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * A customer may install stable v2.2.0 (schema 2.12.0) before v2.3 ships, then
 * upgrade. These checks pin the properties that make that upgrade - and a code
 * rollback afterwards - safe without a database reset.
 */

/** Capture every SQL statement a migration issues, without a real database. */
async function collectSql(migrationIndex: number): Promise<string> {
  const statements: string[] = [];
  const fakePool = {
    query: async (text: string) => {
      statements.push(text);
      return { rows: [], rowCount: 0 };
    },
  };
  await MIGRATIONS[migrationIndex].up(fakePool as never);
  return statements.join("\n");
}

const DESTRUCTIVE = [
  /\bDROP\s+TABLE\b(?!\s+IF\s+EXISTS\s+\w*tmp)/i,
  /\bDROP\s+COLUMN\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bALTER\s+COLUMN\s+\w+\s+TYPE\b/i,
  /\bALTER\s+COLUMN\s+\w+\s+SET\s+NOT\s+NULL\b/i,
];

describe("migration safety — v2.2 to v2.3 upgrade compatibility", () => {
  it("keeps DATABASE_SCHEMA_VERSION equal to the latest migration", () => {
    expect(getLatestMigrationVersion()).toBe(DATABASE_SCHEMA_VERSION);
  });

  it("advances PRODUCT_VERSION whenever the schema moves past the last stable release (2.2.0 / 2.12.0)", () => {
    // The shipped v2.2.0 updater verifies, after switching images, that the
    // running app reports exactly the manifest version, and rolls back on any
    // mismatch. A build that carries a newer schema but a stale PRODUCT_VERSION
    // therefore cannot be delivered to a customer at all: the update installs
    // and then un-installs itself. If the schema is ahead of 2.12.0, the
    // product version must be ahead of 2.2.0.
    if (cmpSemver(DATABASE_SCHEMA_VERSION, "2.12.0") > 0) {
      expect(cmpSemver(PRODUCT_VERSION, "2.2.0")).toBe(1);
    }
  });

  it("has migrations in ascending version order with unique versions", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    const sorted = [...versions].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );
    expect(versions).toEqual(sorted);
  });

  it("declares itself backwards compatible, and every migration is additive", async () => {
    expect(SCHEMA_BACKWARDS_COMPATIBLE).toBe(true);
    for (let i = 0; i < MIGRATIONS.length; i += 1) {
      const sql = await collectSql(i);
      for (const pattern of DESTRUCTIVE) {
        expect(pattern.test(sql), `${MIGRATIONS[i].version} (${MIGRATIONS[i].name}) runs ${pattern}`).toBe(false);
      }
    }
  });

  it("only needs to apply 2.13.0 and 2.14.0 on top of a v2.2.0 (2.12.0) database, additively", async () => {
    const deltaFrom212 = MIGRATIONS.filter(
      (m) => m.version.localeCompare("2.12.0", undefined, { numeric: true }) > 0,
    );
    expect(deltaFrom212.map((m) => m.version)).toEqual(["2.13.0", "2.14.0"]);

    const idx = MIGRATIONS.findIndex((m) => m.version === "2.13.0");
    const sql = await collectSql(idx);
    // Additive shapes only.
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS/i);
    // Never touches the data a v2.2 customer already has.
    expect(sql).not.toMatch(/\b(jobs|brands|generated_assets|video_revisions|publications|provider_credentials_vault|admin_users)\b\s+DROP/i);
  });

  it("2.14.0 only removes triggers - it never deletes rows", async () => {
    const idx = MIGRATIONS.findIndex((m) => m.version === "2.14.0");
    const sql = await collectSql(idx);
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS trg_cleanup_failed_jobs/i);
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS trg_convert_needs_review/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|FUNCTION)\b/i);
  });
});
