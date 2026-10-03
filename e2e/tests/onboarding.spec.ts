/** The getting-started checklist on the Servers page, and bringing it back from Settings. */
import { expect, test } from "@playwright/test";
import { api, signIn } from "./helpers";

test("the checklist can be hidden and shown again", async ({ page }) => {
  await signIn(page);
  await api(page, "onboarding.show", {});
  await page.goto("/");
  const card = page.getByText("Getting started").or(page.getByText("You're all set"));
  await expect(card.first()).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Getting started progress" })).toBeVisible();

  await page.getByRole("button", { name: "Hide getting started" }).click();
  await expect(page.getByRole("progressbar", { name: "Getting started progress" })).toBeHidden();

  await page.goto("/settings");
  await page.getByRole("button", { name: "Show it again" }).click();
  await expect(page.getByText("The getting started list is back")).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("progressbar", { name: "Getting started progress" })).toBeVisible();
});
