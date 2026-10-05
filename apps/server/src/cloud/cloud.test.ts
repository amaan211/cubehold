import { describe, expect, it } from "vitest";
import { advance, savingAutomation } from "./service.js";
import type { CloudMeta } from "./types.js";

const size = {
  id: "cx23",
  label: "CX23",
  vcpus: 2,
  memoryMb: 4096,
  diskGb: 40,
  arch: "x64" as const,
  dedicated: false,
  priceHourly: 0.0088,
  priceMonthly: 5.49,
  currency: "EUR" as const,
  priceSource: "api" as const,
};

function meta(power: CloudMeta["power"], lastAt: string, month = lastAt.slice(0, 7)) {
  return {
    provider: "hetzner" as const,
    size,
    snapshot: power === "hibernated" ? { handle: "1", imageId: "1", sizeGb: 2, at: lastAt } : null,
    power,
    lastMonth: null,
    usage: { month, running: 10, stopped: 0, hibernated: 0, lastAt },
  };
}

describe("cloud usage", () => {
  it("adds the time since the last update to the current power state", () => {
    const r = advance(
      meta("running", "2026-09-10T10:00:00.000Z"),
      new Date("2026-09-10T12:30:00.000Z"),
    );
    expect(r.usage.running).toBeCloseTo(12.5, 5);
    const h = advance(
      meta("hibernated", "2026-09-10T10:00:00.000Z"),
      new Date("2026-09-10T11:00:00.000Z"),
    );
    expect(h.usage).toMatchObject({ running: 10, hibernated: 1 });
    const s = advance(
      meta("stopping", "2026-09-10T10:00:00.000Z"),
      new Date("2026-09-10T11:00:00.000Z"),
    );
    expect(s.usage.running).toBe(11); // still billed as running until it is off
  });

  it("closes the month and counts only this month's part of the gap", () => {
    const r = advance(
      meta("running", "2026-09-30T23:00:00.000Z"),
      new Date("2026-10-01T02:00:00.000Z"),
    );
    expect(r.lastMonth).toEqual({ month: "2026-09", total: 0.09 });
    expect(r.usage.month).toBe("2026-10");
    expect(r.usage.running).toBeCloseTo(2, 5);
  });
});

describe("defaults on a cloud VM", () => {
  it("stop after 15 minutes, then delete the VM keeping a snapshot (stop it on AWS)", () => {
    for (const p of ["hetzner", "digitalocean", "vultr", "linode"] as const) {
      expect(savingAutomation(p)).toEqual({ idleStopMinutes: 15, vmIdle: "hibernate" });
    }
    expect(savingAutomation("aws")).toEqual({ idleStopMinutes: 15, vmIdle: "stop" });
  });
});
