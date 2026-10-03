import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findJavaBinary } from "./java.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cubehold-java-test-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A runtime folder with an empty file where the java binary would be. */
function runtime(name: string, rel: string): string {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), "");
  return root;
}

describe("findJavaBinary", () => {
  it("finds java in the Linux and Windows layout", async () => {
    const root = runtime("linux", "jdk-21.0.8+9-jre/bin/java");
    expect(await findJavaBinary(root, "java")).toBe(path.join(root, "jdk-21.0.8+9-jre/bin/java"));
  });

  it("finds java in the macOS layout, under Contents/Home", async () => {
    const root = runtime("mac", "jdk-25.0.4.1+1-jre/Contents/Home/bin/java");
    expect(await findJavaBinary(root, "java")).toBe(
      path.join(root, "jdk-25.0.4.1+1-jre/Contents/Home/bin/java"),
    );
  });

  it("returns null when there is no java", async () => {
    const root = runtime("empty", "jdk-21/lib/readme.txt");
    expect(await findJavaBinary(root, "java")).toBeNull();
  });
});
