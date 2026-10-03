import { expect, type Page } from "@playwright/test";

export const OWNER = { username: "owner", password: "correct-horse-battery" };

/** Create the owner on a fresh panel, or sign in to one that has it. */
export async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  const form = page.locator("#username");
  const shell = page.getByRole("link", { name: "New server" }).first();
  await expect(form.or(shell)).toBeVisible();
  if (!(await form.isVisible())) return;
  await form.fill(OWNER.username);
  await page.locator("#password").fill(OWNER.password);
  if (page.url().includes("/setup")) {
    await page.locator("#confirm").fill(OWNER.password);
    await page.getByRole("button", { name: "Create account" }).click();
  } else {
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expect(page).not.toHaveURL(/\/(setup|login)/);
}

/** What xterm.js shows in the console. */
export function consoleText(page: Page) {
  return page.locator(".xterm-rows");
}

/** Call the panel's API with the page's session (tRPC over HTTP). */
export async function api<T>(page: Page, path: string, input?: unknown): Promise<T> {
  const res =
    input === undefined
      ? await page.request.get(`/trpc/${path}`)
      : await page.request.post(`/trpc/${path}`, { data: input });
  const body = (await res.json()) as { result?: { data: T }; error?: { message: string } };
  if (!res.ok() || !body.result) throw new Error(`${path}: ${body.error?.message ?? res.status()}`);
  return body.result.data;
}

/** Servers a failed earlier run left behind (named "E2E …") would hold the test port. */
export async function removeLeftovers(page: Page): Promise<void> {
  const servers = await api<Array<{ id: string; name: string; status: string }>>(
    page,
    "servers.list",
  );
  for (const s of servers.filter((x) => x.name.startsWith("E2E "))) {
    if (s.status !== "stopped" && s.status !== "crashed") {
      await api(page, "servers.kill", { serverId: s.id }).catch(() => {});
      for (let i = 0; i < 60; i++) {
        const { status } = await api<{ status: string }>(
          page,
          `servers.get?input=${encodeURIComponent(JSON.stringify({ serverId: s.id }))}`,
        );
        if (status === "stopped" || status === "crashed") break;
        await page.waitForTimeout(500);
      }
    }
    await api(page, "servers.remove", { serverId: s.id });
  }
}
