/**
 * The core loop on a real Minecraft server: create a Paper server, let the
 * panel download Java and the jar, start it, use the console, have a player
 * join, stop it, delete it.
 */
import { devices, expect, test } from "@playwright/test";
import mineflayer from "mineflayer";
import { consoleText, removeLeftovers, signIn } from "./helpers";

// The newest version the test player (mineflayer) speaks.
const MC_VERSION = "1.21.11";
const MC_PORT = Number(process.env.CUBEHOLD_E2E_MC_PORT ?? 25590);
const NAME = `E2E ${Date.now().toString(36)}`;

test.describe
  .serial("a Paper server", () => {
    let serverPath = "";

    test.beforeEach(async ({ page }) => {
      await signIn(page);
    });

    test("is created and installed", async ({ page }) => {
      await removeLeftovers(page);
      await page.goto("/servers/new");
      await page.getByRole("button", { name: /^Paper/ }).click();
      await expect(page.locator("#version")).toBeEnabled();
      await page.locator("#version").selectOption(MC_VERSION);
      await page.locator("#port").fill(String(MC_PORT));
      // The test player has no Microsoft account.
      await page.getByRole("switch", { name: /online mode/i }).click();
      await page.locator("#name").fill(NAME);
      await page.getByRole("checkbox").check();
      await page.getByRole("button", { name: "Create server" }).click();

      // The wizard itself is /servers/new; wait for the new server's page.
      await page.waitForURL(
        (u) => /^\/servers\/[^/]+$/.test(u.pathname) && u.pathname !== "/servers/new",
      );
      serverPath = new URL(page.url()).pathname;
      await expect(page.getByRole("heading", { name: NAME })).toBeVisible();
      // Java and the Paper jar download here.
      await expect(page.getByTestId("server-status")).toHaveText("stopped", {
        timeout: 8 * 60_000,
      });
    });

    test("starts and runs console commands", async ({ page }) => {
      await page.goto(serverPath);
      await page.getByRole("button", { name: "Start", exact: true }).click();
      await expect(page.getByTestId("server-status")).toHaveText("running", {
        timeout: 5 * 60_000,
      });

      await page.goto(`${serverPath}/console`);
      await expect(consoleText(page)).toContainText("Done (", { timeout: 60_000 });
      const input = page.getByRole("textbox", { name: "Server command" });
      await input.fill("say e2e-hello");
      await input.press("Enter");
      await expect(consoleText(page)).toContainText("e2e-hello");
    });

    test("lets a player join and chat", async ({ page, baseURL }) => {
      await page.goto(serverPath);
      const host = new URL(baseURL ?? "http://127.0.0.1").hostname;
      const bot = mineflayer.createBot({
        host,
        port: MC_PORT,
        username: "E2EPlayer",
        version: MC_VERSION,
        auth: "offline",
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("the player did not spawn in 60 s")),
            60_000,
          );
          bot.once("spawn", () => {
            clearTimeout(timer);
            resolve();
          });
          bot.once("kicked", (reason) => reject(new Error(`kicked: ${JSON.stringify(reason)}`)));
          bot.once("error", reject);
        });
        await expect(page.getByText("1 online")).toBeVisible();
        bot.chat("hello from the e2e player");
        await page.goto(`${serverPath}/console`);
        await expect(consoleText(page)).toContainText("hello from the e2e player");
      } finally {
        bot.quit();
      }
      await page.goto(serverPath);
      await expect(page.getByText("1 online")).toBeHidden();
    });

    test("stops", async ({ page }) => {
      await page.goto(serverPath);
      await page.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(page.getByTestId("server-status")).toHaveText("stopped", {
        timeout: 2 * 60_000,
      });
    });

    test("fits a phone screen on every tab", async ({ browser }) => {
      const phone = await browser.newContext({
        ...devices["Pixel 7"],
        baseURL: test.info().project.use.baseURL,
      });
      const page = await phone.newPage();
      await signIn(page);
      const wide: string[] = [];
      for (const tab of [
        "",
        "/console",
        "/players",
        "/files",
        "/addons",
        "/backups",
        "/schedules",
        "/network",
        "/security",
        "/settings",
      ]) {
        await page.goto(`${serverPath}${tab}`);
        await page.waitForLoadState("networkidle");
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        if (overflow > 1) wide.push(`${tab || "/"} (${overflow}px)`);
      }
      await phone.close();
      expect(wide, "tabs that scroll sideways on a phone").toEqual([]);
    });

    test("is deleted", async ({ page }) => {
      await page.goto(serverPath);
      await page.getByRole("button", { name: "Delete server" }).click();
      const confirm = page.locator("#confirm-name");
      const backup = page.getByRole("switch", { name: /back up before deleting/i });
      // The dialog measures the files first, then offers a backup (on by default).
      await expect(confirm.or(backup).first()).toBeVisible();
      if ((await backup.isVisible()) && (await backup.getAttribute("aria-checked")) === "true") {
        await backup.click();
      }
      await confirm.fill(NAME);
      await page.getByRole("button", { name: "Delete permanently" }).click();
      await page.waitForURL((u) => u.pathname === "/");
      await expect(page.getByText(NAME)).toBeHidden();
    });
  });
