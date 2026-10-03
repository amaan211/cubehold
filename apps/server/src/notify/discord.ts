/**
 * Discord webhooks: one message at a time per webhook, with Discord's rate
 * limit (HTTP 429) waited out, so a burst of joins never loses messages or
 * gets the webhook blocked.
 */

export interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  footer?: { text: string };
  timestamp?: string;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class DiscordError extends Error {
  constructor(
    message: string,
    /** Discord said the webhook does not exist (deleted, or a wrong URL). */
    readonly gone = false,
  ) {
    super(message);
  }
}

export const COLORS = {
  green: 0x03a14a,
  gray: 0x6b7280,
  red: 0xdc2626,
  blue: 0x2563eb,
  amber: 0xd97706,
} as const;

/** Keep player names like Steve_the_1st from turning into Markdown. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_~|>#[\]()-])/g, "\\$1");
}

export class DiscordSender {
  #queues = new Map<string, Promise<void>>();

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  /** Queue a message; resolves once it is delivered, rejects if it cannot be. */
  send(webhook: string, embed: DiscordEmbed): Promise<void> {
    const previous = this.#queues.get(webhook) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.#post(webhook, embed));
    this.#queues.set(webhook, next);
    void next
      .catch(() => {})
      .finally(() => {
        if (this.#queues.get(webhook) === next) this.#queues.delete(webhook);
      });
    return next;
  }

  async #post(webhook: string, embed: DiscordEmbed): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(webhook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            embeds: [embed],
            // Player names and crash messages must never ping anyone.
            allowed_mentions: { parse: [] },
          }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        if (attempt === 3) {
          throw new DiscordError(
            `Discord did not answer: ${err instanceof Error ? err.message : err}`,
          );
        }
        await sleep(2_000 * (attempt + 1));
        continue;
      }
      if (res.ok) return;
      if (res.status === 429) {
        const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
        const header = Number(res.headers.get("retry-after"));
        const seconds = body.retry_after ?? (Number.isFinite(header) ? header : 2);
        await sleep(Math.min(60, Math.max(0.5, seconds)) * 1000);
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await sleep(2_000 * (attempt + 1));
        continue;
      }
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 404) {
        throw new DiscordError(
          "Discord says this webhook does not exist. It may have been deleted.",
          true,
        );
      }
      throw new DiscordError(
        `Discord refused the message (HTTP ${res.status}): ${text.slice(0, 200)}`,
      );
    }
    throw new DiscordError("Discord kept rate-limiting the webhook");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
