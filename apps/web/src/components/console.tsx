import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { ConsoleLine } from "@cubehold/shared";
import { useMutation } from "@tanstack/react-query";
import { SendHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { realtime, useServerLive } from "@/lib/realtime";
import { useTheme } from "@/lib/theme";
import { errorMessage, useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes
const ANSI = /\x1b\[[0-9;]*m/g;
/** Minecraft already prefixes most lines with [HH:MM:SS ...]; don't add a second clock. */
const HAS_TIMESTAMP = /^\[\d{2}:\d{2}:\d{2}/;

function formatLine(l: ConsoleLine): string {
  const body = l.line.replace(/\r/g, "");
  const t = `${DIM}${new Date(l.at).toLocaleTimeString(undefined, { hour12: false })}${RESET} `;
  if (l.stream === "system") return `${t}${GREEN}${body}${RESET}`;
  const prefix = HAS_TIMESTAMP.test(body.replace(ANSI, "")) ? "" : t;
  if (l.stream === "stderr") return `${prefix}${RED}${body}${RESET}`;
  return `${prefix}${body}${RESET}`;
}

const EMPTY_HINT = `${DIM}No output yet. Start the server to see its console here.${RESET}`;

// Minecraft colours WARN lines bright yellow; darken it on light backgrounds to stay readable.
const THEMES = {
  dark: {
    background: "#0f1115",
    foreground: "#e6e8ec",
    cursor: "#e6e8ec",
    selectionBackground: "#3a4a3f",
    green: "#4ac776",
    brightGreen: "#4ac776",
  },
  light: {
    background: "#fbfbfc",
    foreground: "#1d2025",
    cursor: "#1d2025",
    selectionBackground: "#cfe9d8",
    green: "#1a7f37",
    brightGreen: "#1a7f37",
    yellow: "#8a5a00",
    brightYellow: "#8a5a00",
    red: "#c0262d",
    brightRed: "#c0262d",
  },
};

interface ConsoleProps {
  serverId: string;
  className?: string;
  /** Height of the terminal area. */
  heightClass?: string;
}

export function Console({ serverId, className, heightClass = "h-[28rem]" }: ConsoleProps) {
  const trpc = useTRPC();
  const live = useServerLive(serverId);
  const { resolved } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  /** Follow the tail unless the user scrolled up to read history. */
  const followRef = useRef(true);
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);

  const send = useMutation(
    trpc.servers.sendCommand.mutationOptions({
      onError: (err) => toast.error(errorMessage(err)),
    }),
  );

  // Mount the terminal once; the theme is applied by the effect below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once effect
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const term = new Terminal({
      disableStdin: true,
      convertEol: true,
      scrollback: 2000,
      fontSize: 12.5,
      fontFamily: "ui-monospace, 'JetBrains Mono', 'Cascadia Code', Menlo, Consolas, monospace",
      theme: THEMES[resolved],
      cursorStyle: "underline",
      cursorInactiveStyle: "none",
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    const atBottom = () => {
      const buf = term.buffer.active;
      return buf.viewportY + term.rows >= buf.length - 1;
    };
    const scrollSub = term.onScroll(() => {
      followRef.current = atBottom();
    });
    const ro = new ResizeObserver(() => {
      fit.fit();
      if (followRef.current) term.scrollToBottom();
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      scrollSub.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = THEMES[resolved];
  }, [resolved]);

  // Once the snapshot is in, replay history and then follow live lines. Doing
  // both in one effect means no line can slip between seeding and subscribing.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !live.ready) return;
    const write = (l: ConsoleLine) => {
      term.writeln(formatLine(l));
      if (followRef.current) term.scrollToBottom();
    };
    term.clear();
    const history = realtime.get(serverId).console;
    for (const l of history) term.writeln(formatLine(l));
    if (history.length === 0) term.writeln(EMPTY_HINT);
    followRef.current = true;
    term.scrollToBottom();
    return realtime.onLine(serverId, write);
  }, [serverId, live.ready]);

  const canSend = live.status === "running" || live.status === "starting";

  const submit = () => {
    const c = command.trim();
    if (!c) return;
    send.mutate({ serverId, command: c });
    setHistory((h) => [c, ...h.filter((x) => x !== c)].slice(0, 50));
    setHistIdx(-1);
    setCommand("");
  };

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border border-border bg-card",
        className,
      )}
    >
      <div ref={containerRef} className={cn("w-full p-2", heightClass)} />
      <form
        className="flex items-center gap-2 border-t border-border p-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <span className="pl-2 font-mono text-sm text-muted-foreground">&gt;</span>
        <Input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              const next = Math.min(history.length - 1, histIdx + 1);
              setHistIdx(next);
              setCommand(history[next] ?? "");
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              const next = Math.max(-1, histIdx - 1);
              setHistIdx(next);
              setCommand(next === -1 ? "" : (history[next] ?? ""));
            }
          }}
          placeholder={
            canSend ? "Type a server command, e.g. say hello" : "Start the server to send commands"
          }
          disabled={!canSend}
          className="border-0 font-mono shadow-none focus-visible:ring-0"
          aria-label="Server command"
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={!canSend || !command.trim() || send.isPending}
        >
          <SendHorizontal /> Send
        </Button>
      </form>
    </div>
  );
}
