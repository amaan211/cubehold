/**
 * The cloud parts that work without a cloud account: the New server choice
 * that leads to connecting one, the cost page, and the VPS guide's prices.
 * (Creating VMs is tested against a fake provider API, not here.)
 */
import { expect, type Page, test } from "@playwright/test";
import { api, signIn } from "./helpers";

/** These tests are about a panel without cloud accounts; an existing install may have some. */
async function skipWithAccounts(page: Page) {
  const accounts = await api<unknown[]>(page, "cloud.accounts");
  test.skip(accounts.length > 0, "this panel has cloud accounts connected");
}

test("New server offers a cloud server and asks for an account first", async ({ page }) => {
  await signIn(page);
  await skipWithAccounts(page);
  await page.goto("/servers/new");
  await page.getByRole("button", { name: /A new cloud server/ }).click();
  await expect(page.getByText("Connect a cloud account first")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create the VM and server" })).toBeDisabled();

  await page.getByRole("button", { name: "Connect a cloud account" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Hetzner").first()).toBeVisible();
  await expect(dialog.locator("#acct-token")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // Back to this computer: the usual form.
  await page.getByRole("button", { name: /This computer/ }).click();
  await expect(page.getByText("Connect a cloud account first")).toBeHidden();
});

test("the cost page explains itself without cloud accounts", async ({ page }) => {
  await signIn(page);
  await skipWithAccounts(page);
  await page.goto("/costs");
  await expect(page.getByRole("heading", { level: 1, name: "Cloud costs" })).toBeVisible();
  await expect(page.getByText("No cloud accounts connected")).toBeVisible();
});

test("the VPS guide counts Hetzner's IPv4 address, like the cloud page", async ({ page }) => {
  await signIn(page);
  await page.goto("/hosts/guide");
  const row = page.locator("tr", { hasText: "CX23" });
  await expect(row).toContainText(/5[.,]99/);
  await expect(row).toContainText("plus €0.50 for the IPv4 address");
});
