import { useQuery } from "@tanstack/react-query";
import type { inferOutput } from "@trpc/tanstack-react-query";
import { AlertTriangle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { cn, formatMb, formatMoney } from "@/lib/utils";

type Trpc = ReturnType<typeof useTRPC>;
export type CloudSizeView = inferOutput<Trpc["cloud"]["sizes"]>[number];

/**
 * Accounts, locations and sizes for creating a VM, with the first of each
 * picked. Locations and sizes are asked for only while `enabled`.
 */
export function useCloudCatalog(enabled = true) {
  const trpc = useTRPC();
  const accounts = useQuery(trpc.cloud.accounts.queryOptions());
  const [accountId, setAccountId] = useState("");
  const [region, setRegion] = useState("");
  useEffect(() => {
    if (!accountId && accounts.data?.[0]) setAccountId(accounts.data[0].id);
  }, [accounts.data, accountId]);
  const account = accounts.data?.find((a) => a.id === accountId);
  const regions = useQuery(
    trpc.cloud.regions.queryOptions(
      { accountId },
      { enabled: enabled && !!accountId, staleTime: 3_600_000 },
    ),
  );
  useEffect(() => {
    if (regions.data && !regions.data.some((r) => r.id === region))
      setRegion(regions.data[0]?.id ?? "");
  }, [regions.data, region]);
  const sizes = useQuery(
    trpc.cloud.sizes.queryOptions(
      { accountId, region },
      { enabled: enabled && !!accountId && !!region, staleTime: 3_600_000 },
    ),
  );
  return { accounts, account, accountId, setAccountId, regions, region, setRegion, sizes };
}

export type CloudCatalog = ReturnType<typeof useCloudCatalog>;

/** Account and location selects. */
export function CloudWhereFields({ catalog }: { catalog: CloudCatalog }) {
  const { accounts, accountId, setAccountId, regions, region, setRegion } = catalog;
  const byContinent = useMemo(() => {
    const groups = new Map<string, NonNullable<typeof regions.data>>();
    for (const r of regions.data ?? []) {
      const k = r.continent ?? "Other";
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    return [...groups.entries()];
  }, [regions.data]);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="acct">Account</Label>
        <Select id="acct" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.data?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label} ({a.providerLabel})
            </option>
          ))}
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="region">Location</Label>
        <Select
          id="region"
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          disabled={!regions.data}
        >
          {!regions.data && <option>{regions.isError ? "Could not load" : "Loading…"}</option>}
          {byContinent.map(([continent, list]) => (
            <optgroup key={continent} label={continent}>
              {list.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
        {regions.isError && (
          <p className="text-xs text-destructive">{errorMessage(regions.error)}</p>
        )}
      </div>
    </div>
  );
}

/**
 * The sizes with what a month costs. Sizes that cannot be picked (`fits`
 * false) and ones below the advice (`dim`) are greyed out; `best` gets a badge.
 */
export function CloudSizeTable({
  catalog,
  fits,
  dim,
  best,
  selected,
  onSelect,
}: {
  catalog: CloudCatalog;
  fits: (s: CloudSizeView) => boolean;
  dim?: (s: CloudSizeView) => boolean;
  best: CloudSizeView | undefined;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const { sizes } = catalog;
  if (sizes.isError) return <p className="text-sm text-destructive">{errorMessage(sizes.error)}</p>;
  if (!sizes.data)
    return <p className="text-sm text-muted-foreground">Loading sizes and prices…</p>;
  if (sizes.data.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No sizes with 2 GB of memory or more here. Pick another location.
      </p>
    );
  return (
    <div className="max-h-96 overflow-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card text-left text-xs text-muted-foreground">
          <tr className="border-b border-border">
            <th className="p-2 font-medium">Size</th>
            <th className="p-2 font-medium">Machine</th>
            <th className="p-2 font-medium">Always on</th>
            <th className="p-2 font-medium">3 h a day</th>
          </tr>
        </thead>
        <tbody>
          {sizes.data.map((s) => {
            const ok = fits(s);
            return (
              <tr
                key={s.id}
                onClick={() => ok && onSelect(s.id)}
                className={cn(
                  "border-b border-border last:border-0",
                  ok
                    ? "cursor-pointer hover:bg-muted/60"
                    : "cursor-not-allowed text-muted-foreground",
                  dim?.(s) && "text-muted-foreground",
                  selected === s.id && "bg-accent/60",
                )}
              >
                <td className="p-2">
                  <span className="flex items-center gap-1.5">
                    <input
                      type="radio"
                      readOnly
                      disabled={!ok}
                      checked={selected === s.id}
                      aria-label={s.label}
                      className="accent-[var(--primary)]"
                    />
                    {s.label}
                    {s === best && <Badge variant="success">best fit</Badge>}
                  </span>
                </td>
                <td className="p-2 whitespace-nowrap">
                  {s.vcpus} {s.dedicated ? "dedicated" : ""} CPU · {formatMb(s.memoryMb)} ·{" "}
                  {s.diskGb} GB{s.arch === "arm64" ? " · ARM" : ""}
                  {s.burstable ? " · burstable" : ""}
                </td>
                <td className="p-2 whitespace-nowrap">
                  {formatMoney(s.estimate.alwaysOn, s.currency)}
                  {s.priceSource === "estimate" ? "*" : ""}
                </td>
                <td className="p-2 whitespace-nowrap">
                  {formatMoney(s.estimate.threeHoursADay, s.currency)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** What the prices include, in the same words everywhere a VM is priced. */
export function CloudPriceNotes({
  catalog,
  chosen,
}: {
  catalog: CloudCatalog;
  chosen: CloudSizeView | undefined;
}) {
  const provider = catalog.account?.provider;
  const extras =
    provider === "hetzner"
      ? ", plus €0.50 for its IPv4 address"
      : provider === "aws"
        ? ", plus its public IPv4 address ($3.65) and 30 GB disk ($2.40)"
        : "; its IPv4 address is included";
  const idle =
    chosen?.estimate.idleMode === "stop" || provider === "aws"
      ? "stopped"
      : "deleted and kept as a snapshot";
  return (
    <div className="space-y-1.5 text-xs text-muted-foreground">
      {chosen?.burstable && (
        <p className="flex gap-1.5 text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> Burstable instances are cheap for
          light use; a busy server pays extra for CPU above the baseline.
        </p>
      )}
      <p>
        Per month, before VAT or sales tax. <strong>Always on</strong> is the VM running all month
        {extras}. <strong>3 h a day</strong> assumes 3 hours of play a day, with the VM {idle} the
        rest of the time, which is the default for servers on a cloud VM.
      </p>
      {catalog.sizes.data?.some((s) => s.priceSource === "estimate") && (
        <p>* US East price; the access key may not read AWS's price list for this region.</p>
      )}
      {chosen && (
        <p className="text-foreground">
          {chosen.label} costs about {formatMoney(chosen.estimate.hourly, chosen.currency)} for
          every hour it runs, and {formatMoney(chosen.estimate.alwaysOn, chosen.currency)} if it is
          never turned off.
        </p>
      )}
    </div>
  );
}
