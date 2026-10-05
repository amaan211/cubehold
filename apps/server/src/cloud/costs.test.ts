import { describe, expect, it } from "vitest";
import type { CloudUsageSize } from "../db/schema.js";
import { type LiveHost, splitByDay, summarizeCosts, type UsageRow } from "./costs.js";

const CX23: CloudUsageSize = {
  id: "cx23",
  label: "CX23",
  priceHourly: 0.0088,
  priceMonthly: 5.49,
  diskGb: 40,
  currency: "EUR",
};

function row(day: string, h: Partial<UsageRow> = {}): UsageRow {
  return {
    hostId: "h1",
    day,
    hostName: "Survival",
    accountId: "cloud-1",
    provider: "hetzner",
    region: "fsn1",
    size: CX23,
    running: 0,
    stopped: 0,
    hibernated: 0,
    snapshotGbHours: 0,
    ...h,
  };
}

function live(h: Partial<LiveHost> = {}): LiveHost {
  return {
    hostId: "h1",
    name: "Survival",
    provider: "hetzner",
    accountLabel: "Hetzner",
    region: "fsn1",
    size: CX23,
    power: "running",
    snapshotGb: 0,
    servers: [{ id: "s1", name: "Survival" }],
    lastMonth: null,
    ...h,
  };
}

describe("splitByDay", () => {
  it("splits at UTC midnight", () => {
    expect(splitByDay(new Date("2026-10-04T22:00:00Z"), new Date("2026-10-06T01:30:00Z"))).toEqual([
      { day: "2026-10-04", hours: 2 },
      { day: "2026-10-05", hours: 24 },
      { day: "2026-10-06", hours: 1.5 },
    ]);
    expect(splitByDay(new Date("2026-10-05T10:00:00Z"), new Date("2026-10-05T10:00:00Z"))).toEqual(
      [],
    );
  });
});

describe("summarizeCosts", () => {
  it("adds up days, VMs and kinds of cost, and stops at the monthly cap", () => {
    // 24 h a day for the whole of October: the cap (5.49) is reached on day 26.
    const rows = Array.from({ length: 31 }, (_, i) =>
      row(`2026-10-${String(i + 1).padStart(2, "0")}`, { running: 24 }),
    );
    const s = summarizeCosts(
      "2026-10",
      rows,
      [],
      [],
      ["2026-10"],
      new Date("2026-11-02T00:00:00Z"),
    );
    expect(s.current).toBe(false);
    const eur = s.currencies[0];
    expect(eur?.currency).toBe("EUR");
    expect(eur?.soFar.compute).toBeCloseTo(5.49, 6);
    expect(eur?.soFar.ip).toBeCloseTo(0.5, 6); // capped like the VM

    expect(eur?.days).toHaveLength(31);
    expect(eur?.days[0]?.compute).toBeCloseTo(24 * 0.0088, 6);
    expect(eur?.days[30]?.compute).toBe(0); // capped
    const sum = eur?.days.reduce((n, d) => n + d.total, 0) ?? 0;
    expect(sum).toBeCloseTo(eur?.soFar.total ?? -1, 6);
    expect(s.hosts[0]).toMatchObject({ name: "Survival", state: "deleted", projected: null });
  });

  it("projects the rest of the month from what each VM is doing now", () => {
    const now = new Date("2026-10-11T00:00:00Z"); // 21 days = 504 h left
    const rows = [row("2026-10-10", { running: 3, hibernated: 21, snapshotGbHours: 21 * 4 })];
    const s = summarizeCosts(
      "2026-10",
      rows,
      [],
      [live({ power: "hibernated", snapshotGb: 4 })],
      ["2026-10"],
      now,
    );
    const eur = s.currencies[0];
    const h = s.hosts[0];
    expect(h?.state).toBe("hibernated");
    expect(h?.perHour).toBeCloseTo((4 * 0.0143) / 730, 8);
    const storageNow = (21 * 4 * 0.0143) / 730;
    const storageLater = ((21 + 504) * 4 * 0.0143) / 730;
    expect(h?.cost.storage).toBeCloseTo(storageNow, 8);
    expect(h?.projected).toBeCloseTo(3 * 0.0088 + (3 * 0.5) / 730 + storageLater, 6);
    expect(eur?.projected).toBeCloseTo(h?.projected ?? -1, 8);
  });

  it("keeps deleted VMs, shows new ones, and takes last month from the log", () => {
    const now = new Date("2026-10-05T12:00:00Z");
    const s = summarizeCosts(
      "2026-10",
      [row("2026-10-01", { hostId: "gone", hostName: "Old", running: 10 })],
      [row("2026-09-30", { running: 24 })],
      [live({ hostId: "new", name: "Fresh", servers: [] })],
      ["2026-10", "2026-09"],
      now,
    );
    expect(s.hosts.map((h) => [h.name, h.state])).toEqual([
      ["Fresh", "running"],
      ["Old", "deleted"],
    ]);
    expect(s.currencies[0]?.lastMonth).toBeCloseTo(24 * 0.0088 + (24 * 0.5) / 730, 6);
    expect(s.currencies[0]?.perHour).toBeCloseTo(0.0088 + 0.5 / 730, 8);
  });

  it("uses a host's own total for last month when the log does not have it", () => {
    const s = summarizeCosts(
      "2026-10",
      [],
      [],
      [live({ lastMonth: { month: "2026-09", total: 4.2 } })],
      ["2026-10"],
      new Date("2026-10-01T06:00:00Z"),
    );
    expect(s.currencies[0]?.lastMonth).toBe(4.2);
  });
});
