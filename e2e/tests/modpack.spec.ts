/**
 * A modpack end to end: a small .mrpack built here (NeoForge 1.21.1 plus one
 * real mod from Modrinth, a config override, and a server.properties that
 * tries to change the port), uploaded through the page, installed, started.
 * Covers the NeoForge installer, launching through its args file, the mod
 * download with hash check, and the overrides.
 *
 * Skipped with CUBEHOLD_E2E_SKIP_MODPACK=1: NeoForge downloads about 100 MB.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import yazl from "yazl";
import { api, consoleText, removeLeftovers, signIn } from "./helpers";

const MC = "1.21.1";
const PORT = Number(process.env.CUBEHOLD_E2E_MC_PORT ?? 25590) + 1;
const NAME = `E2E pack ${Date.now().toString(36)}`;

test.skip(process.env.CUBEHOLD_E2E_SKIP_MODPACK === "1", "modpack test turned off");

/** The newest stable NeoForge for MC: mods on Modrinth are built against recent ones. */
async function newestNeoForge(): Promise<string> {
  const xml = await (
    await fetch("https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml")
  ).text();
  const prefix = MC.replace(/^1\./, "");
  const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
    .map((m) => m[1] as string)
    .filter((v) => v.startsWith(`${prefix}.`) && !v.includes("-"));
  const newest = versions.at(-1);
  if (!newest) throw new Error(`no NeoForge for ${MC}`);
  return newest;
}

let NEOFORGE = "";

async function buildPack(): Promise<string> {
  NEOFORGE = await newestNeoForge();
  const q = new URLSearchParams({
    loaders: JSON.stringify(["neoforge"]),
    game_versions: JSON.stringify([MC]),
  });
  const versions = (await (
    await fetch(`https://api.modrinth.com/v2/project/ferrite-core/version?${q}`)
  ).json()) as Array<{
    files: Array<{
      url: string;
      filename: string;
      size: number;
      hashes: { sha1: string; sha512: string };
    }>;
  }>;
  const file = versions[0]?.files[0];
  if (!file) throw new Error("FerriteCore has no NeoForge build for this version on Modrinth");
  const index = {
    formatVersion: 1,
    game: "minecraft",
    versionId: "1.0.0",
    name: "E2E Pack",
    summary: "Built by the cubehold end-to-end tests",
    dependencies: { minecraft: MC, neoforge: NEOFORGE },
    files: [
      {
        path: `mods/${file.filename}`,
        hashes: file.hashes,
        env: { client: "required", server: "required" },
        downloads: [file.url],
        fileSize: file.size,
      },
    ],
  };
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(index)), "modrinth.index.json");
  zip.addBuffer(Buffer.from("from = overrides\n"), "overrides/config/e2e.toml");
  zip.addBuffer(Buffer.from("from = server-overrides\n"), "server-overrides/config/e2e.toml");
  // The pack's gameplay settings apply; the port and login mode stay the panel's.
  zip.addBuffer(
    Buffer.from("difficulty=hard\nserver-port=12345\nonline-mode=true\n"),
    "overrides/server.properties",
  );
  zip.end();
  const out = path.join(os.tmpdir(), `cubehold-e2e-${Date.now()}.mrpack`);
  await new Promise<void>((resolve, reject) =>
    zip.outputStream.pipe(fs.createWriteStream(out)).on("close", resolve).on("error", reject),
  );
  return out;
}

test.describe
  .serial("a modpack", () => {
    let serverPath = "";
    let serverId = "";

    test.beforeEach(async ({ page }) => {
      await signIn(page);
    });

    test("is read and installed", async ({ page }) => {
      await removeLeftovers(page);
      const pack = await buildPack();
      try {
        await page.goto("/servers/modpack");
        await page.locator('input[type="file"]').setInputFiles(pack);
        await expect(page.getByText("E2E Pack")).toBeVisible();
        await expect(page.getByText(`NeoForge ${NEOFORGE}`)).toBeVisible();

        await page.locator("#pack-name").fill(NAME);
        await page.locator("#pack-port").fill(String(PORT));
        await page.getByRole("switch", { name: /online mode/i }).click();
        await page.getByRole("checkbox").check();
        await page.getByRole("button", { name: "Install modpack" }).click();
      } finally {
        fs.rmSync(pack, { force: true });
      }

      await page.waitForURL(
        (u) => /^\/servers\/[^/]+$/.test(u.pathname) && u.pathname !== "/servers/modpack",
      );
      serverPath = new URL(page.url()).pathname;
      serverId = serverPath.split("/").pop() as string;
      // NeoForge's installer downloads Minecraft and its libraries.
      await expect(page.getByTestId("server-status")).toHaveText("stopped", {
        timeout: 9 * 60_000,
      });
      await expect(page.getByText(/Installation failed/)).toBeHidden();

      const input = (p: string) => encodeURIComponent(JSON.stringify({ serverId, path: p }));
      const mods = await api<{ entries: Array<{ name: string }> }>(
        page,
        `files.list?input=${input("mods")}`,
      );
      expect(mods.entries.map((m) => m.name).some((n) => n.startsWith("ferritecore"))).toBe(true);
      const config = await api<{ content: string }>(
        page,
        `files.read?input=${input("config/e2e.toml")}`,
      );
      expect(config.content).toContain("server-overrides");
      const props = await api<{ content: string }>(
        page,
        `files.read?input=${input("server.properties")}`,
      );
      expect(props.content).toContain("difficulty=hard");
      expect(props.content).toContain(`server-port=${PORT}`);
      expect(props.content).toContain("online-mode=false");
    });

    test("starts on NeoForge with the mod loaded", async ({ page }) => {
      await page.goto(serverPath);
      await page.getByRole("button", { name: "Start", exact: true }).click();
      await expect(page.getByTestId("server-status")).toHaveText("running", {
        timeout: 6 * 60_000,
      });
      await page.goto(`${serverPath}/console`);
      await expect(consoleText(page)).toContainText("Done (", { timeout: 60_000 });
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(page.getByTestId("server-status")).toHaveText("stopped", {
        timeout: 2 * 60_000,
      });
    });

    test("is deleted", async ({ page }) => {
      await api(page, "servers.remove", { serverId });
      await page.goto("/");
      await expect(page.getByText(NAME)).toBeHidden();
    });
  });
