import type { ScheduleAction } from "@cubehold/shared";
import { Cron } from "croner";
import { and, asc, eq } from "drizzle-orm";
import { newId } from "../auth/session.js";
import { type Db, schema } from "../db/index.js";
import type { RealtimeBus } from "../realtime/bus.js";
import type { BackupService } from "./backups.js";
import { ACTIVE, errMessage, nowIso, ServerError, type ServerService } from "./service.js";

const { schedules } = schema;
type ScheduleRow = typeof schedules.$inferSelect;

export interface ScheduleFields {
  name: string;
  cron: string;
  action: ScheduleAction;
  payload?: string;
  warnSeconds?: number;
  enabled: boolean;
}

/** Five fields only (minute hour day month weekday), so expressions mean what they look like. */
function parseCron(expr: string, fn?: () => Promise<void>): Cron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ServerError(
      "VALIDATION",
      "Use five fields: minute hour day-of-month month day-of-week",
      {
        cron: "Needs five fields",
      },
    );
  }
  try {
    return fn
      ? new Cron(expr, { mode: "5-part", protect: true, catch: true }, fn)
      : new Cron(expr, { mode: "5-part", paused: true });
  } catch (err) {
    throw new ServerError("VALIDATION", `Invalid schedule: ${errMessage(err)}`, {
      cron: "Invalid",
    });
  }
}

/**
 * Cron-style jobs per server: restart, stop, start, backup, command,
 * broadcast. Runs in the panel, in the panel machine's time zone; a job due
 * while the panel is down is skipped, not replayed.
 */
export class ScheduleService {
  #jobs = new Map<string, { job: Cron; serverId: string }>();

  constructor(
    private readonly db: Db,
    private readonly servers: ServerService,
    private readonly backups: BackupService,
    private readonly bus: RealtimeBus,
  ) {
    servers.events.on("removed", (serverId) => {
      for (const [id, entry] of this.#jobs) {
        if (entry.serverId !== serverId) continue;
        entry.job.stop();
        this.#jobs.delete(id);
      }
    });
  }

  async init(): Promise<void> {
    for (const s of await this.db.select().from(schedules)) this.#arm(s);
  }

  dispose(): void {
    for (const { job } of this.#jobs.values()) job.stop();
    this.#jobs.clear();
  }

  preview(expr: string): { valid: boolean; error: string | null; next: string[] } {
    try {
      const job = parseCron(expr);
      const next = job.nextRuns(5).map((d) => d.toISOString());
      job.stop();
      return { valid: true, error: null, next };
    } catch (err) {
      return { valid: false, error: errMessage(err), next: [] };
    }
  }

  async list(serverId: string) {
    await this.servers.row(serverId);
    const rows = await this.db
      .select()
      .from(schedules)
      .where(eq(schedules.serverId, serverId))
      .orderBy(asc(schedules.createdAt));
    return rows.map((s) => ({
      ...s,
      nextRunAt: s.enabled ? (this.#jobs.get(s.id)?.job.nextRun()?.toISOString() ?? null) : null,
    }));
  }

  async create(serverId: string, f: ScheduleFields) {
    await this.servers.row(serverId);
    this.#validate(f);
    const id = newId();
    await this.db.insert(schedules).values({
      id,
      serverId,
      name: f.name,
      cron: f.cron.trim(),
      action: f.action,
      payload: f.payload?.trim() || null,
      warnSeconds: f.warnSeconds ?? null,
      enabled: f.enabled,
    });
    this.#arm(await this.#get(serverId, id));
    return this.#get(serverId, id);
  }

  async update(serverId: string, scheduleId: string, f: ScheduleFields) {
    await this.#get(serverId, scheduleId);
    this.#validate(f);
    await this.db
      .update(schedules)
      .set({
        name: f.name,
        cron: f.cron.trim(),
        action: f.action,
        payload: f.payload?.trim() || null,
        warnSeconds: f.warnSeconds ?? null,
        enabled: f.enabled,
        updatedAt: nowIso(),
      })
      .where(eq(schedules.id, scheduleId));
    this.#arm(await this.#get(serverId, scheduleId));
    return this.#get(serverId, scheduleId);
  }

  async remove(serverId: string, scheduleId: string): Promise<void> {
    await this.#get(serverId, scheduleId);
    this.#jobs.get(scheduleId)?.job.stop();
    this.#jobs.delete(scheduleId);
    await this.db.delete(schedules).where(eq(schedules.id, scheduleId));
  }

  /** Run a schedule now, regardless of its time. Resolves when the action is done. */
  async runNow(serverId: string, scheduleId: string) {
    await this.#get(serverId, scheduleId);
    await this.#execute(scheduleId);
    return this.#get(serverId, scheduleId);
  }

  #validate(f: ScheduleFields): void {
    parseCron(f.cron).stop();
    if ((f.action === "command" || f.action === "broadcast") && !f.payload?.trim()) {
      throw new ServerError(
        "VALIDATION",
        f.action === "command" ? "Enter the command to run" : "Enter the message to send",
        { payload: "Required" },
      );
    }
  }

  #arm(s: ScheduleRow): void {
    this.#jobs.get(s.id)?.job.stop();
    this.#jobs.delete(s.id);
    if (!s.enabled) return;
    try {
      const job = parseCron(s.cron, () => this.#execute(s.id));
      this.#jobs.set(s.id, { job, serverId: s.serverId });
    } catch (err) {
      console.warn(`schedule ${s.id} has an invalid expression: ${errMessage(err)}`);
    }
  }

  async #execute(scheduleId: string): Promise<void> {
    const s = await this.db.select().from(schedules).where(eq(schedules.id, scheduleId)).get();
    if (!s) return;
    let result: "ok" | "skipped" | "failed" = "ok";
    let message: string;
    try {
      ({ result, message } = await this.#perform(s));
    } catch (err) {
      result = "failed";
      message = errMessage(err);
    }
    await this.db
      .update(schedules)
      .set({ lastRunAt: nowIso(), lastResult: result, lastMessage: message })
      .where(eq(schedules.id, scheduleId));
    this.bus.system(s.serverId, `Schedule "${s.name}": ${message}`);
  }

  async #perform(s: ScheduleRow): Promise<{ result: "ok" | "skipped"; message: string }> {
    const id = s.serverId;
    const status = this.bus.snapshot(id).status;
    const running = status === "running";
    const skipped = (message: string) => ({ result: "skipped" as const, message });

    switch (s.action as ScheduleAction) {
      case "restart":
        if (!running) return skipped("skipped, the server is not running");
        await this.#warn(id, s.warnSeconds ?? 0, "restart");
        await this.servers.restart(id);
        return { result: "ok", message: "restarted" };
      case "stop":
        if (!running) return skipped("skipped, the server is not running");
        await this.#warn(id, s.warnSeconds ?? 0, "stop");
        await this.servers.stop(id);
        return { result: "ok", message: "stopped" };
      case "start":
        if (ACTIVE.includes(status)) return skipped("skipped, the server is already running");
        await this.servers.start(id);
        return { result: "ok", message: "started" };
      case "backup": {
        const b = await this.backups.createAndWait(id, {
          kind: "scheduled",
          scope: "full",
          label: s.name,
        });
        return { result: "ok", message: `backup done (${b.files ?? 0} files)` };
      }
      case "command": {
        if (!running) return skipped("skipped, the server is not running");
        const reply = await this.servers.command(id, s.payload ?? "");
        return {
          result: "ok",
          message: reply
            ? `ran /${s.payload}: ${reply.replace(/§./g, "").slice(0, 200)}`
            : `ran /${s.payload}`,
        };
      }
      case "broadcast":
        if (!running) return skipped("skipped, the server is not running");
        await this.servers.say(id, s.payload ?? "");
        return { result: "ok", message: "message sent" };
    }
  }

  /** Count down in chat before a restart or stop: at the start, at 1 minute and at 10 seconds. */
  async #warn(serverId: string, seconds: number, verb: "restart" | "stop"): Promise<void> {
    if (seconds <= 0) return;
    const say = (left: number) =>
      this.servers
        .say(
          serverId,
          `The server will ${verb} in ${left >= 60 ? `${Math.round(left / 60)} minute${left >= 120 ? "s" : ""}` : `${left} seconds`}.`,
        )
        .catch(() => null);
    const marks = [seconds, 60, 10].filter((m, i, a) => m <= seconds && a.indexOf(m) === i);
    let left = seconds;
    for (const mark of marks) {
      await sleep((left - mark) * 1000);
      left = mark;
      if (this.bus.snapshot(serverId).status !== "running") return;
      await say(mark);
    }
    await sleep(left * 1000);
  }

  async #get(serverId: string, scheduleId: string): Promise<ScheduleRow> {
    const s = await this.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.id, scheduleId), eq(schedules.serverId, serverId)))
      .get();
    if (!s) throw new ServerError("NOT_FOUND", "Schedule not found");
    return s;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
