import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Comment lines removed, same rule as the release-workflow safety tests:
 * the workflow documents the imagetools | awk pipe it must not run.
 */
const workflowWithoutComments = (): string =>
  fs
    .readFileSync(path.join(REPO_ROOT, ".github/workflows/ghcr-candidate.yml"), "utf8")
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

describe("GHCR candidate digest resolution", () => {
  it("takes the pushed digest from build metadata and does not pipe imagetools into awk", () => {
    const yml = workflowWithoutComments();
    expect(yml).toMatch(/--metadata-file "\$META"/);
    expect(yml).toMatch(/ghcr-candidate-digest\.sh from-metadata/);
    expect(yml).toMatch(/ghcr-candidate-digest\.sh confirm/);
    expect(yml).not.toMatch(/imagetools inspect[^\n]*\|/);
    expect(yml).not.toMatch(/awk[^\n]*Digest:/);

    const buildAt = yml.indexOf("Build and push candidate image");
    const resolveAt = yml.indexOf("Resolve pushed candidate digest");
    const promoteAt = yml.indexOf("Promote accepted digest without rebuild");
    expect(buildAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeGreaterThan(buildAt);
    expect(promoteAt).toBeGreaterThan(resolveAt);

    const buildStep = yml.slice(buildAt, resolveAt);
    expect(buildStep).toMatch(/if: inputs\.mode == 'candidate'/);
    expect(buildStep).toMatch(/--tag "\$IMAGE"/);
    expect(buildStep).not.toMatch(/:stable/);

    const resolveStep = yml.slice(resolveAt, promoteAt);
    expect(resolveStep).toMatch(/if: inputs\.mode == 'candidate'/);
    expect(resolveStep).toMatch(/steps\.push\.outputs\.digest/);
  });

  it.skipIf(process.platform === "win32")(
    "parses metadata, ignores child digests, and reproduces the exit-255 pipe failure",
    () => {
      const out = execFileSync("bash", ["scripts/release/ghcr-candidate-digest.sh", "self-test"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      expect(out).toMatch(/self-test ok/);
    },
  );
});
