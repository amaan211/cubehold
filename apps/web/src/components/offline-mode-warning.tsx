import { TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

/** What turning off Microsoft/Mojang authentication means, in plain words. */
export function OfflineModeWarning({
  existingWorld,
  className,
}: {
  /** Include the note about players losing their data when switching an existing world. */
  existingWorld: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200",
        className,
      )}
    >
      <p className="flex items-center gap-2 font-medium">
        <TriangleAlert className="size-4 shrink-0" /> Offline mode: no account checks
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] leading-snug">
        <li>Anyone can join with any username, including yours or an operator's.</li>
        <li>
          The whitelist only checks names, so it can be spoofed. For servers others can reach, add a
          login plugin such as AuthMe or nLogin.
        </li>
        <li>Chat signing and Mojang's player-key checks are turned off too.</li>
        {existingWorld && (
          <li>
            Players get different IDs in offline mode. Switching an existing world makes them start
            with empty inventories; their old data stays in the world folder.
          </li>
        )}
      </ul>
    </div>
  );
}
