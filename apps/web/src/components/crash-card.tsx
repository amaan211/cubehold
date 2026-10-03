import type { ServerStatus } from "@cubehold/shared";
import { useQuery } from "@tanstack/react-query";
import { FileWarning, Flame, RotateCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { useTRPC } from "@/lib/trpc";
import { formatDate } from "@/lib/utils";

const RECENT_MS = 60 * 60_000;

/**
 * The latest crash, explained: shown while the server is crashed or for an
 * hour after a crash it recovered from.
 */
export function CrashCard({ serverId, status }: { serverId: string; status: ServerStatus }) {
  const trpc = useTRPC();
  const crashes = useQuery(
    trpc.servers.crashes.queryOptions({ serverId }, { refetchInterval: 20_000 }),
  );
  const [open, setOpen] = useState<string | "list" | null>(null);
  const latest = crashes.data?.[0];
  if (!latest) return null;
  const recent = Date.now() - Date.parse(latest.at) < RECENT_MS;
  if (status !== "crashed" && !recent) return null;
  const a = latest.analysis;

  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <Flame className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="min-w-0 space-y-1 text-sm">
            <p className="font-medium">
              {a?.title ?? "The server crashed"}{" "}
              <span className="font-normal text-muted-foreground">· {formatDate(latest.at)}</span>
            </p>
            {a?.hint && <p className="text-muted-foreground">{a.hint}</p>}
            {a?.suspects && a.suspects.length > 0 && (
              <p className="text-muted-foreground">
                Involved:{" "}
                <span className="font-mono text-xs text-foreground">{a.suspects.join(", ")}</span>
              </p>
            )}
            {latest.restartInMs !== null && (
              <p className="inline-flex items-center gap-1 text-muted-foreground">
                <RotateCw className="size-3.5" />
                {status === "crashed"
                  ? `Restarting automatically in about ${Math.round(latest.restartInMs / 1000)} seconds.`
                  : "Restarted automatically."}
              </p>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {latest.report && (
            <Button size="sm" variant="outline" onClick={() => setOpen(latest.report)}>
              <FileWarning /> View report
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setOpen("list")}>
            All crashes ({crashes.data?.length})
          </Button>
        </div>
      </div>
      <CrashReportsDialog
        serverId={serverId}
        open={open}
        onOpen={setOpen}
        onClose={() => setOpen(null)}
      />
    </div>
  );
}

function CrashReportsDialog({
  serverId,
  open,
  onOpen,
  onClose,
}: {
  serverId: string;
  open: string | null;
  onOpen: (file: string) => void;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const file = open && open !== "list" ? open : null;
  const report = useQuery(
    trpc.servers.crashReport.queryOptions(
      { serverId, file: file ?? "" },
      { enabled: Boolean(file) },
    ),
  );
  const history = useQuery(
    trpc.servers.crashes.queryOptions({ serverId }, { enabled: open === "list" }),
  );
  const files = useQuery(
    trpc.servers.crashReports.queryOptions({ serverId }, { enabled: open === "list" }),
  );

  return (
    <Dialog
      open={open !== null}
      onClose={onClose}
      title={file ? file : "Crashes"}
      description={file ? undefined : "Recent unexpected stops and every crash report on disk."}
      className="max-w-3xl"
    >
      {file && report.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {file && report.error && <p className="text-sm text-destructive">{report.error.message}</p>}
      {file && report.data && (
        <div className="space-y-3">
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
            <p className="font-medium">{report.data.analysis.title}</p>
            <p className="mt-1 text-muted-foreground">{report.data.analysis.hint}</p>
            {report.data.analysis.exception && (
              <p className="mt-2 break-all font-mono text-xs">{report.data.analysis.exception}</p>
            )}
          </div>
          <pre className="max-h-[55vh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">
            {report.data.text}
          </pre>
        </div>
      )}
      {open === "list" && (
        <div className="space-y-4 text-sm">
          <ul className="divide-y divide-border rounded-md border border-border">
            {(history.data ?? []).map((c) => (
              <li key={c.at} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div>
                  <p className="font-medium">{c.analysis?.title ?? "Stopped unexpectedly"}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(c.at)} · exit code {c.code ?? "?"}
                    {c.restartInMs !== null ? " · restarted automatically" : ""}
                  </p>
                </div>
                {c.report && (
                  <Button size="sm" variant="outline" onClick={() => onOpen(c.report as string)}>
                    Report
                  </Button>
                )}
              </li>
            ))}
            {history.data?.length === 0 && (
              <li className="p-3 text-muted-foreground">No crashes recorded.</li>
            )}
          </ul>
          {(files.data?.length ?? 0) > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Reports on disk
              </p>
              <ul className="space-y-1">
                {files.data?.map((f) => (
                  <li key={f.file}>
                    <button
                      type="button"
                      className="font-mono text-xs text-primary hover:underline"
                      onClick={() => onOpen(f.file)}
                    >
                      {f.file}
                    </button>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {formatDate(f.modifiedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
