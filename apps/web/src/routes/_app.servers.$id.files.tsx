import type { FileEntry } from "@cubehold/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ChevronRight,
  Download,
  File,
  FileArchive,
  FileCode,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  HardDrive,
  Image,
  Loader2,
  Package,
  Pencil,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CodeEditor } from "@/components/code-editor";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useServerLive } from "@/lib/realtime";
import { errorMessage, queryClient, useTRPC } from "@/lib/trpc";
import { downloadUrl, UploadError, uploadFile, zipUrl } from "@/lib/upload";
import { cn, formatBytes, timeAgo } from "@/lib/utils";

export const Route = createFileRoute("/_app/servers/$id/files")({
  validateSearch: (s: Record<string, unknown>): { path?: string; file?: string } => ({
    path: typeof s.path === "string" && s.path ? s.path : undefined,
    file: typeof s.file === "string" && s.file ? s.file : undefined,
  }),
  component: Files,
});

const TEXT_EXT =
  /\.(txt|json|json5|mcmeta|ya?ml|properties|toml|cfg|conf|ini|log|md|csv|sh|bat|cmd|sk|js|html|xml|lang|secret|snbt|mcfunction)$/i;
const ARCHIVE_EXT = /\.(zip|jar|mrpack)$/i;

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

function iconFor(e: FileEntry) {
  if (e.kind === "dir") return Folder;
  const n = e.name.toLowerCase();
  if (n.endsWith(".jar")) return Package;
  if (ARCHIVE_EXT.test(n) || /\.(gz|7z|tar)$/.test(n)) return FileArchive;
  if (/\.(png|jpe?g|gif|webp)$/.test(n)) return Image;
  if (/\.(json|ya?ml|properties|toml|cfg|conf|ini)$/.test(n)) return FileCode;
  if (TEXT_EXT.test(n)) return FileText;
  return File;
}

type Modal =
  | { kind: "mkdir" }
  | { kind: "newfile" }
  | { kind: "rename"; entry: FileEntry }
  | { kind: "delete"; names: string[] }
  | { kind: "compress"; names: string[] }
  | { kind: "extract"; entry: FileEntry }
  | { kind: "overwrite"; files: File[] }
  | null;

function Files() {
  const { id } = Route.useParams();
  const search = Route.useSearch();
  const dir = search.path ?? "";
  const navigate = useNavigate({ from: Route.fullPath });
  const trpc = useTRPC();
  const live = useServerLive(id);
  const list = useQuery(trpc.files.list.queryOptions({ serverId: id, path: dir }));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<Modal>(null);
  const [uploads, setUploads] = useState<Array<{ name: string; progress: number }>>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: selection belongs to one folder
  useEffect(() => setSelected(new Set()), [dir]);

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: trpc.files.list.queryKey() }),
    [trpc],
  );
  const onError = (err: unknown) => toast.error(errorMessage(err));
  const opts = { onError, onSuccess: () => void refresh() };
  const mkdir = useMutation(trpc.files.mkdir.mutationOptions(opts));
  const write = useMutation(trpc.files.write.mutationOptions(opts));
  const rename = useMutation(trpc.files.rename.mutationOptions(opts));
  const remove = useMutation(trpc.files.remove.mutationOptions(opts));
  const archive = useMutation(trpc.files.archive.mutationOptions(opts));
  const extract = useMutation(trpc.files.extract.mutationOptions(opts));

  const go = (path: string) => void navigate({ search: { path: path || undefined } });
  const open = (file: string) => void navigate({ search: { path: dir || undefined, file } });
  const close = () => void navigate({ search: { path: dir || undefined } });

  async function upload(files: File[], overwrite: boolean) {
    const conflicts: File[] = [];
    setUploads(files.map((f) => ({ name: f.name, progress: 0 })));
    for (const [i, file] of files.entries()) {
      try {
        await uploadFile({
          serverId: id,
          dir,
          file,
          overwrite,
          onProgress: (p) =>
            setUploads((u) => u.map((x, j) => (j === i ? { ...x, progress: p } : x))),
        });
      } catch (err) {
        if (err instanceof UploadError && err.status === 409 && !overwrite) conflicts.push(file);
        else toast.error(`${file.name}: ${errorMessage(err)}`);
      }
    }
    setUploads([]);
    void refresh();
    const done = files.length - conflicts.length;
    if (done > 0) toast.success(`Uploaded ${done} file${done === 1 ? "" : "s"}`);
    if (conflicts.length > 0) setModal({ kind: "overwrite", files: conflicts });
  }

  const entries = list.data?.entries ?? [];
  const crumbs = dir ? dir.split("/") : [];
  const allSelected = entries.length > 0 && selected.size === entries.length;
  const selectedNames = [...selected];

  if (search.file) {
    return (
      <EditorPanel
        serverId={id}
        path={search.file}
        running={live.status === "running"}
        onClose={close}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Folder" className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
          <button
            type="button"
            onClick={() => go("")}
            className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-muted"
          >
            <HardDrive className="size-3.5" /> server
          </button>
          {crumbs.map((c, i) => (
            <span key={crumbs.slice(0, i + 1).join("/")} className="inline-flex items-center gap-1">
              <ChevronRight className="size-3.5 text-muted-foreground" />
              <button
                type="button"
                onClick={() => go(crumbs.slice(0, i + 1).join("/"))}
                className="rounded px-1.5 py-0.5 hover:bg-muted"
              >
                {c}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setModal({ kind: "mkdir" })}>
            <FolderPlus /> Folder
          </Button>
          <Button size="sm" variant="outline" onClick={() => setModal({ kind: "newfile" })}>
            <FilePlus /> File
          </Button>
          <Button
            size="sm"
            onClick={() => fileInput.current?.click()}
            disabled={uploads.length > 0}
          >
            <Upload /> Upload
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = "";
              if (files.length) void upload(files, false);
            }}
          />
        </div>
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
          <span className="mr-auto">{selected.size} selected</span>
          <Button size="sm" variant="outline" asChild>
            <a href={zipUrl(id, dir, selectedNames)} download>
              <Download /> Download zip
            </a>
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setModal({ kind: "compress", names: selectedNames })}
          >
            <FileArchive /> Compress
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setModal({ kind: "delete", names: selectedNames })}
          >
            <Trash2 /> Delete
          </Button>
        </div>
      )}

      {uploads.map((u) => (
        <div key={u.name} className="rounded-lg border border-border bg-card p-2 text-sm">
          <div className="flex justify-between gap-3">
            <span className="truncate">Uploading {u.name}</span>
            <span className="tabular-nums text-muted-foreground">
              {Math.round(u.progress * 100)}%
            </span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary" style={{ width: `${u.progress * 100}%` }} />
          </div>
        </div>
      ))}

      <Card
        className={cn("overflow-hidden", dragging && "ring-2 ring-primary")}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const files = [...e.dataTransfer.files];
          if (files.length) void upload(files, false);
        }}
      >
        {list.error ? (
          <p className="p-4 text-sm text-destructive">{errorMessage(list.error)}</p>
        ) : list.isLoading ? (
          <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        ) : (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="w-10 py-2 pr-3 pl-4">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={allSelected}
                      onChange={() =>
                        setSelected(allSelected ? new Set() : new Set(entries.map((e) => e.name)))
                      }
                    />
                  </th>
                  <th className="w-full py-2 font-medium">Name</th>
                  <th className="py-2 pl-4 text-right font-medium">Size</th>
                  <th className="py-2 pl-6 font-medium">Modified</th>
                  <th className="w-44 py-2 pr-3 text-right font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {dir && (
                  <tr className="hover:bg-muted/40">
                    <td />
                    <td colSpan={4} className="py-2">
                      <button
                        type="button"
                        className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground"
                        onClick={() => go(crumbs.slice(0, -1).join("/"))}
                      >
                        <Folder className="size-4" /> ..
                      </button>
                    </td>
                  </tr>
                )}
                {entries.map((e) => {
                  const Icon = iconFor(e);
                  const path = join(dir, e.name);
                  const editable = e.kind === "file" && TEXT_EXT.test(e.name);
                  const panel = e.name.startsWith(".cubehold");
                  return (
                    <tr
                      key={e.name}
                      className={cn(
                        "group hover:bg-muted/40",
                        selected.has(e.name) && "bg-accent/40",
                      )}
                    >
                      <td className="py-1.5 pr-3 pl-4">
                        <input
                          type="checkbox"
                          aria-label={`Select ${e.name}`}
                          checked={selected.has(e.name)}
                          onChange={() =>
                            setSelected((s) => {
                              const n = new Set(s);
                              if (n.has(e.name)) n.delete(e.name);
                              else n.add(e.name);
                              return n;
                            })
                          }
                        />
                      </td>
                      <td className="max-w-0 py-1.5">
                        <div className="flex min-w-0 items-center gap-2">
                          {e.kind === "dir" ? (
                            <button
                              type="button"
                              className="inline-flex min-w-0 items-center gap-2 font-medium hover:underline"
                              onClick={() => go(path)}
                            >
                              <Icon className="size-4 shrink-0 text-primary" />
                              <span className="truncate">{e.name}</span>
                            </button>
                          ) : editable ? (
                            <button
                              type="button"
                              className="inline-flex min-w-0 items-center gap-2 hover:underline"
                              onClick={() => open(path)}
                            >
                              <Icon className="size-4 shrink-0 text-muted-foreground" />
                              <span className="truncate">{e.name}</span>
                            </button>
                          ) : (
                            <a
                              href={downloadUrl(id, path)}
                              className="inline-flex min-w-0 items-center gap-2 hover:underline"
                              download
                            >
                              <Icon className="size-4 shrink-0 text-muted-foreground" />
                              <span className="truncate">{e.name}</span>
                            </a>
                          )}
                          {panel && (
                            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              panel
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-1.5 text-right whitespace-nowrap tabular-nums text-muted-foreground">
                        {e.kind === "file" ? formatBytes(e.sizeBytes) : ""}
                      </td>
                      <td className="py-1.5 pl-6 whitespace-nowrap text-muted-foreground">
                        {timeAgo(e.modifiedAt)}
                      </td>
                      <td className="py-1.5 pr-2">
                        <div className="flex justify-end gap-0.5 opacity-70 group-hover:opacity-100">
                          {editable && (
                            <RowAction label="Edit" onClick={() => open(path)}>
                              <FileCode />
                            </RowAction>
                          )}
                          {e.kind === "file" &&
                            ARCHIVE_EXT.test(e.name) &&
                            !e.name.endsWith(".jar") && (
                              <RowAction
                                label="Extract"
                                onClick={() => setModal({ kind: "extract", entry: e })}
                              >
                                <FileArchive />
                              </RowAction>
                            )}
                          <RowAction
                            label="Download"
                            asLink
                            href={
                              e.kind === "dir" ? zipUrl(id, dir, [e.name]) : downloadUrl(id, path)
                            }
                          >
                            <Download />
                          </RowAction>
                          <RowAction
                            label="Rename"
                            onClick={() => setModal({ kind: "rename", entry: e })}
                          >
                            <Pencil />
                          </RowAction>
                          <RowAction
                            label="Delete"
                            danger
                            onClick={() => setModal({ kind: "delete", names: [e.name] })}
                          >
                            <Trash2 />
                          </RowAction>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {entries.length === 0 && (
                  <tr>
                    <td colSpan={5} className="p-6 text-center text-sm text-muted-foreground">
                      This folder is empty. Drop files here to upload them.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="text-xs text-muted-foreground">
        Drag files onto the list to upload them into this folder.
      </p>

      <NameDialog
        open={modal?.kind === "mkdir"}
        title="New folder"
        label="Folder name"
        initial=""
        onClose={() => setModal(null)}
        onSubmit={(name) =>
          mkdir.mutateAsync({ serverId: id, path: join(dir, name) }).then(() => setModal(null))
        }
      />
      <NameDialog
        open={modal?.kind === "newfile"}
        title="New file"
        label="File name"
        initial=""
        onClose={() => setModal(null)}
        onSubmit={async (name) => {
          const existing = entries.some((e) => e.name === name);
          if (existing) throw new Error(`${name} already exists`);
          await write.mutateAsync({ serverId: id, path: join(dir, name), content: "" });
          setModal(null);
          if (TEXT_EXT.test(name)) open(join(dir, name));
        }}
      />
      {modal?.kind === "rename" && (
        <NameDialog
          open
          title={`Rename ${modal.entry.name}`}
          label="New name"
          initial={modal.entry.name}
          onClose={() => setModal(null)}
          onSubmit={(name) =>
            rename
              .mutateAsync({ serverId: id, from: join(dir, modal.entry.name), to: join(dir, name) })
              .then(() => setModal(null))
          }
        />
      )}
      {modal?.kind === "compress" && (
        <NameDialog
          open
          title={`Compress ${modal.names.length === 1 ? modal.names[0] : `${modal.names.length} items`}`}
          label="Archive name"
          initial={`${modal.names.length === 1 ? modal.names[0] : "archive"}.zip`}
          onClose={() => setModal(null)}
          onSubmit={(name) => {
            setModal(null);
            setSelected(new Set());
            return archive
              .mutateAsync({
                serverId: id,
                dir,
                names: modal.names,
                archiveName: name.endsWith(".zip") ? name : `${name}.zip`,
              })
              .then(() => undefined);
          }}
        />
      )}
      {modal?.kind === "extract" && (
        <NameDialog
          open
          title={`Extract ${modal.entry.name}`}
          label="Into folder (empty for this folder)"
          initial={modal.entry.name.replace(/\.(zip|mrpack)$/i, "")}
          allowEmpty
          onClose={() => setModal(null)}
          onSubmit={(into) => {
            setModal(null);
            return extract
              .mutateAsync({
                serverId: id,
                path: join(dir, modal.entry.name),
                into: into ? join(dir, into) : dir,
              })
              .then(() => undefined);
          }}
        />
      )}
      <Dialog
        open={modal?.kind === "delete"}
        onClose={() => setModal(null)}
        title={`Delete ${modal?.kind === "delete" && modal.names.length === 1 ? modal.names[0] : `${modal?.kind === "delete" ? modal.names.length : 0} items`}?`}
        description="Deleted files cannot be recovered, except from a backup."
      >
        {modal?.kind === "delete" && (
          <div className="space-y-4">
            <ul className="max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-xs">
              {modal.names.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setModal(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={remove.isPending}
                onClick={() =>
                  remove
                    .mutateAsync({ serverId: id, paths: modal.names.map((n) => join(dir, n)) })
                    .then(() => {
                      setSelected(new Set());
                      setModal(null);
                    })
                }
              >
                Delete
              </Button>
            </div>
          </div>
        )}
      </Dialog>
      <Dialog
        open={modal?.kind === "overwrite"}
        onClose={() => setModal(null)}
        title="Replace existing files?"
        description="These already exist in this folder."
      >
        {modal?.kind === "overwrite" && (
          <div className="space-y-4">
            <ul className="max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-xs">
              {modal.files.map((f) => (
                <li key={f.name}>{f.name}</li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setModal(null)}>
                Skip them
              </Button>
              <Button
                onClick={() => {
                  const files = modal.files;
                  setModal(null);
                  void upload(files, true);
                }}
              >
                Replace
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function RowAction({
  label,
  onClick,
  children,
  danger,
  asLink,
  href,
}: {
  label: string;
  onClick?: () => void;
  children: React.ReactNode;
  danger?: boolean;
  asLink?: boolean;
  href?: string;
}) {
  const cls = cn("size-7", danger && "hover:text-destructive");
  if (asLink) {
    return (
      <Button size="icon" variant="ghost" className={cls} asChild>
        <a href={href} download title={label} aria-label={label}>
          {children}
        </a>
      </Button>
    );
  }
  return (
    <Button
      size="icon"
      variant="ghost"
      className={cls}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function NameDialog({
  open,
  title,
  label,
  initial,
  allowEmpty,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  label: string;
  initial: string;
  allowEmpty?: boolean;
  onClose: () => void;
  onSubmit: (value: string) => Promise<unknown> | undefined;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset each time it opens
  useEffect(() => {
    if (open) {
      setValue(initial);
      setError(null);
    }
  }, [open]);
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const v = value.trim();
          if (!v && !allowEmpty) return;
          if (/[/\\:*?"<>|]/.test(v)) {
            setError('Names cannot contain / \\ : * ? " < > |');
            return;
          }
          setPending(true);
          try {
            await onSubmit(v);
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setPending(false);
          }
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="name-input">{label}</Label>
          <Input
            id="name-input"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            autoFocus
            onFocus={(e) => {
              const dot = e.target.value.lastIndexOf(".");
              e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
            }}
          />
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || (!allowEmpty && !value.trim())}>
            {pending && <Loader2 className="animate-spin" />} OK
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function EditorPanel({
  serverId,
  path,
  running,
  onClose,
}: {
  serverId: string;
  path: string;
  running: boolean;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const file = useQuery(
    trpc.files.read.queryOptions(
      { serverId, path },
      { staleTime: Number.POSITIVE_INFINITY, refetchOnWindowFocus: false },
    ),
  );
  const [draft, setDraft] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const dirty = draft !== null && draft !== file.data?.content;
  const save = useMutation(
    trpc.files.write.mutationOptions({
      onSuccess: (_d, vars) => {
        queryClient.setQueryData(trpc.files.read.queryKey({ serverId, path }), {
          path,
          content: vars.content,
        });
        setDraft(null);
        void queryClient.invalidateQueries({ queryKey: trpc.files.list.queryKey() });
        toast.success(
          running ? "Saved. Restart the server if it reads this file at startup." : "Saved",
        );
      },
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );
  const doSave = () => {
    if (dirty && draft !== null && !save.isPending) save.mutate({ serverId, path, content: draft });
  };

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const name = path.split("/").pop() ?? path;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-sm">{path}</p>
          <p className="text-xs text-muted-foreground">
            {dirty ? "Unsaved changes · Ctrl+S to save" : "Saved"}
            {running && " · The server is running; many files are only read at startup."}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => (dirty ? setConfirmClose(true) : onClose())}
          >
            <X /> Close
          </Button>
          <Button size="sm" onClick={doSave} disabled={!dirty || save.isPending}>
            {save.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save
          </Button>
        </div>
      </div>
      <Card className="h-[70vh] overflow-hidden">
        {file.error ? (
          <p className="p-4 text-sm text-destructive">{errorMessage(file.error)}</p>
        ) : file.data ? (
          <CodeEditor
            docKey={path}
            fileName={name}
            initial={file.data.content}
            onChange={setDraft}
            onSave={doSave}
          />
        ) : (
          <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        )}
      </Card>
      <Dialog
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        title="Discard unsaved changes?"
        description={`Your edits to ${name} will be lost.`}
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setConfirmClose(false)}>
            Keep editing
          </Button>
          <Button variant="destructive" onClick={onClose}>
            Discard
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
