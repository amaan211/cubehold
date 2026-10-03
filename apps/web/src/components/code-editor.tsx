import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import {
  bracketMatching,
  foldGutter,
  HighlightStyle,
  indentOnInput,
  type LanguageSupport,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { useEffect, useRef } from "react";

/** Colours come from CSS variables, so light and dark themes need no second style. */
const highlight = HighlightStyle.define([
  {
    // Legacy .properties mode tags keys "def" and values "quote".
    tag: [
      t.propertyName,
      t.attributeName,
      t.definition(t.propertyName),
      t.definition(t.variableName),
      t.heading,
    ],
    color: "var(--syntax-key)",
  },
  { tag: [t.string, t.special(t.string), t.quote], color: "var(--syntax-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syntax-number)" },
  { tag: [t.keyword, t.operator, t.meta], color: "var(--syntax-keyword)" },
  {
    tag: [t.comment, t.lineComment, t.blockComment],
    color: "var(--syntax-comment)",
    fontStyle: "italic",
  },
  { tag: t.invalid, color: "var(--destructive)" },
]);

const theme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--card)",
    color: "var(--foreground)",
    fontSize: "13px",
  },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55" },
  ".cm-content": { caretColor: "var(--foreground)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  ".cm-gutters": {
    backgroundColor: "var(--muted)",
    color: "var(--muted-foreground)",
    border: "none",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--muted) 60%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--border)" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in oklch, var(--primary) 25%, transparent)",
  },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklch, var(--primary) 20%, transparent)" },
  ".cm-panels": { backgroundColor: "var(--muted)", color: "var(--foreground)" },
  ".cm-panels input, .cm-panels button": { fontSize: "12px" },
});

/** Language for a file name; plain text when unknown. */
export function languageFor(name: string): LanguageSupport | StreamLanguage<unknown> | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "json" || ext === "mcmeta" || ext === "json5") return json();
  if (ext === "yml" || ext === "yaml") return yaml();
  if (ext === "properties" || ext === "cfg" || ext === "conf" || ext === "ini") {
    return StreamLanguage.define(properties);
  }
  if (ext === "toml") return StreamLanguage.define(toml);
  if (ext === "sh" || ext === "bat" || ext === "cmd") return StreamLanguage.define(shell);
  return null;
}

/**
 * CodeMirror 6 editor. Uncontrolled: `initial` seeds it (and resets it when
 * `docKey` changes); edits are reported through onChange. Ctrl/Cmd+S calls onSave.
 */
export function CodeEditor({
  initial,
  docKey,
  fileName,
  onChange,
  onSave,
  readOnly = false,
}: {
  initial: string;
  docKey: string;
  fileName: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  readOnly?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };

  // biome-ignore lint/correctness/useExhaustiveDependencies: recreate only for a different document
  useEffect(() => {
    if (!host.current) return;
    const lang = languageFor(fileName);
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      foldGutter(),
      history(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      syntaxHighlighting(highlight),
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            handlers.current.onSave?.();
            return true;
          },
        },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
      ]),
      theme,
      EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) handlers.current.onChange(u.state.doc.toString());
      }),
      ...(lang ? [lang] : []),
    ];
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: initial, extensions }),
    });
    view.current = v;
    v.focus();
    return () => {
      v.destroy();
      view.current = null;
    };
  }, [docKey, readOnly]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
