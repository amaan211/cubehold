/**
 * The panel on a phone: the bottom navigation, no sideways scrolling, and
 * what the browser needs to install it as an app.
 */
import { devices, expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.use({ ...devices["Pixel 7"] });

test("the phone layout has bottom navigation and fits the screen", async ({ page }) => {
  await signIn(page);
  const nav = page.getByRole("navigation", { name: "Sections" });
  await expect(nav).toBeVisible();
  for (const [label, heading] of [
    ["Hosts", "Hosts"],
    ["Settings", "Settings"],
    ["New", "New server"],
    ["Servers", "Servers"],
  ] as const) {
    await nav.getByRole("link", { name: label }).click();
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${label} scrolls sideways`).toBeLessThanOrEqual(1);
  }
});

test("the app can be installed", async ({ page, request }) => {
  await page.goto("/");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBe("/manifest.webmanifest");
  const manifest = await (await request.get(href as string)).json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.some((i: { purpose: string }) => i.purpose === "maskable")).toBe(true);
  for (const icon of manifest.icons as Array<{ src: string }>) {
    expect((await request.get(icon.src)).status(), icon.src).toBe(200);
  }
  expect((await request.get("/sw.js")).status()).toBe(200);
  expect((await request.get("/offline.html")).status()).toBe(200);
});
