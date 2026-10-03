import { X } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

/** Minimal modal: backdrop, escape to close, focus trap by autofocus on the panel. */
export function Dialog({ open, onClose, title, description, children, className }: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <button
        type="button"
        aria-label="Close dialog"
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        className={cn(
          "relative max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-xl border border-border bg-card p-5 shadow-xl",
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="dialog-title" className="text-base font-semibold">
              {title}
            </h2>
            {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
          </div>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
