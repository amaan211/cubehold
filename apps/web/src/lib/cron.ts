/** The schedule shapes the builder offers; anything else is edited as a raw expression. */
export type Frequency =
  | { kind: "daily"; time: string }
  | { kind: "hours"; every: number }
  | { kind: "minutes"; every: number }
  | { kind: "weekly"; day: number; time: string }
  | { kind: "custom"; cron: string };

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const pad = (n: number) => String(n).padStart(2, "0");

function splitTime(time: string): [number, number] {
  const [h, m] = time.split(":").map(Number);
  return [Number.isFinite(h) ? (h as number) : 0, Number.isFinite(m) ? (m as number) : 0];
}

export function toCron(f: Frequency): string {
  switch (f.kind) {
    case "daily": {
      const [h, m] = splitTime(f.time);
      return `${m} ${h} * * *`;
    }
    case "weekly": {
      const [h, m] = splitTime(f.time);
      return `${m} ${h} * * ${f.day}`;
    }
    case "hours":
      return `0 */${f.every} * * *`;
    case "minutes":
      return `*/${f.every} * * * *`;
    case "custom":
      return f.cron.trim();
  }
}

export function fromCron(cron: string): Frequency {
  const p = cron.trim().split(/\s+/);
  if (p.length === 5) {
    const [min, hour, dom, mon, dow] = p as [string, string, string, string, string];
    const num = (s: string) => /^\d+$/.test(s);
    if (num(min) && num(hour) && dom === "*" && mon === "*") {
      const time = `${pad(Number(hour))}:${pad(Number(min))}`;
      if (dow === "*") return { kind: "daily", time };
      if (/^[0-6]$/.test(dow)) return { kind: "weekly", day: Number(dow), time };
    }
    const everyHours = /^\*\/(\d+)$/.exec(hour);
    if (min === "0" && everyHours && dom === "*" && mon === "*" && dow === "*") {
      return { kind: "hours", every: Number(everyHours[1]) };
    }
    const everyMin = /^\*\/(\d+)$/.exec(min);
    if (everyMin && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
      return { kind: "minutes", every: Number(everyMin[1]) };
    }
  }
  return { kind: "custom", cron };
}

export function describeCron(cron: string): string {
  const f = fromCron(cron);
  switch (f.kind) {
    case "daily":
      return `Every day at ${f.time}`;
    case "weekly":
      return `Every ${WEEKDAYS[f.day]} at ${f.time}`;
    case "hours":
      return f.every === 1 ? "Every hour" : `Every ${f.every} hours`;
    case "minutes":
      return f.every === 1 ? "Every minute" : `Every ${f.every} minutes`;
    case "custom":
      return `Cron: ${f.cron}`;
  }
}
