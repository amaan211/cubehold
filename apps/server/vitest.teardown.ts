import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * After every test file has finished: remove the notification test's
 * database folder, which libsql keeps open until its worker exits.
 */
export function teardown(): void {
  try {
    fs.rmSync(path.join(os.tmpdir(), "cubehold-notify-test"), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  } catch {}
}
