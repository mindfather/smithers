import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";

setDefaultTimeout(120_000);

const execFileAsync = promisify(execFile);

const DEV_E2E = process.env.SMITHERS_DEV_E2E === "1";
const PG_URL = process.env.SMITHERS_TEST_PG_URL;

const liveTest = (name, fn) => {
  if (!DEV_E2E) {
    test.skip(name, fn);
    return;
  }
  test(name, fn);
};

const livePgTest = (name, fn) => {
  if (!DEV_E2E || !PG_URL) {
    test.skip(name, fn);
    return;
  }
  test(name, fn);
};

describe("backport-v0.29.0-pool.1 assumption: real pg.Pool honors a bound", () => {
  livePgTest("pg.Pool never opens more than `max` concurrent server backends", async () => {
    const applicationName = `smithers-pool-assumption-${Date.now()}`;
    const pool = new pg.Pool({ connectionString: PG_URL, max: 2, application_name: applicationName });
    try {
      const holds = [0, 1, 2].map(() => pool.query("select pg_sleep(0.5)"));

      await new Promise((r) => setTimeout(r, 200));

      const inspector = new pg.Client({ connectionString: PG_URL });
      await inspector.connect();
      try {
        const { rows } = await inspector.query(
          "select count(*)::int as n from pg_stat_activity where application_name = $1",
          [applicationName],
        );
        expect(rows[0].n).toBeLessThanOrEqual(2);
      } finally {
        await inspector.end();
      }

      await Promise.all(holds);
      expect(pool.totalCount).toBeLessThanOrEqual(2);
    } finally {
      await pool.end();
    }
  });
});

describe("backport-v0.29.0-pool.1 assumption: GitHub push/comment targets are real", () => {
  liveTest("mindfather/smithers push-target repo exists on GitHub", async () => {
    const res = await fetch("https://api.github.com/repos/mindfather/smithers", {
      headers: { "User-Agent": "smithers-backport-assumption-test" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.full_name).toBe("mindfather/smithers");
  });

  liveTest("target issue smithersai/smithers#1368 exists and is open", async () => {
    const res = await fetch("https://api.github.com/repos/smithersai/smithers/issues/1368", {
      headers: { "User-Agent": "smithers-backport-assumption-test" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe("open");
    expect(body.title.toLowerCase()).toContain("pool");
  });
});

describe("backport-v0.29.0-pool.1 assumption: pnpm pack rewrites workspace:* to real versions", () => {
  liveTest("packed tarball's package.json has no workspace: protocol deps", async () => {
    const packageDir = resolve(import.meta.dir, "..");
    const destDir = mkdtempSync(join(tmpdir(), "smithers-pack-assumption-"));

    const { stdout } = await execFileAsync(
      "corepack",
      ["pnpm", "pack", "--pack-destination", destDir],
      { cwd: packageDir },
    );

    const tarballPath = stdout.trim().split("\n").pop().trim();

    const { stdout: tarListing } = await execFileAsync("tar", ["-xOzf", tarballPath, "package/package.json"]);
    const packedManifest = JSON.parse(tarListing);

    expect(packedManifest.name).toBe("smithers-orchestrator");
    expect(JSON.stringify(packedManifest.dependencies)).not.toContain("workspace:");

    const dbVersion = JSON.parse(readFileSync(resolve(packageDir, "../db/package.json"), "utf8")).version;
    expect(packedManifest.dependencies["@smithers-orchestrator/db"]).toBe(dbVersion);
  });
});
