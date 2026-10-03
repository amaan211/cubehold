import { hostTotalMemoryMb, listVersions, SUPPORTED_SOFTWARE } from "@cubehold/mc";
import {
  estimateProcessMemoryMb,
  HOST_RESERVE_MB,
  LOCAL_HOST_ID,
  type McVersionOption,
  ServerSoftware,
} from "@cubehold/shared";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../trpc.js";

const cache = new Map<string, { at: number; data: McVersionOption[] }>();
const TTL = 10 * 60_000;

export const mcRouter = router({
  software: protectedProcedure.query(() =>
    (["paper", "vanilla", "fabric", "purpur", "forge", "neoforge"] as const).map((id) => ({
      id,
      label:
        id === "paper"
          ? "Paper"
          : id === "vanilla"
            ? "Vanilla"
            : id === "fabric"
              ? "Fabric"
              : id === "purpur"
                ? "Purpur"
                : id === "forge"
                  ? "Forge"
                  : "NeoForge",
      description:
        id === "paper"
          ? "Recommended. Fast, plugin support, drop-in for vanilla worlds."
          : id === "vanilla"
            ? "Mojang's official server. No plugins."
            : id === "fabric"
              ? "Lightweight mod loader. Needed for Fabric mods."
              : id === "purpur"
                ? "Paper fork with extra gameplay options. Runs Paper plugins."
                : id === "neoforge"
                  ? "Mod loader most new modpacks use (Minecraft 1.20.2 and newer)."
                  : "The classic mod loader, for Forge mods and older modpacks.",
      supported: SUPPORTED_SOFTWARE.includes(id),
    })),
  ),

  versions: protectedProcedure
    .input(z.object({ software: ServerSoftware, includeSnapshots: z.boolean().default(false) }))
    .query(async ({ input }) => {
      const key = input.software;
      const hit = cache.get(key);
      let data: McVersionOption[];
      if (hit && Date.now() - hit.at < TTL) {
        data = hit.data;
      } else {
        try {
          data = await listVersions(input.software);
        } catch (err) {
          throw new TRPCError({
            code: "BAD_GATEWAY",
            message: `Could not fetch ${input.software} versions: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        cache.set(key, { at: Date.now(), data });
      }
      return input.includeSnapshots ? data : data.filter((v) => v.kind === "release");
    }),

  /**
   * Limits for the memory slider. The heap plus the JVM's own overhead must
   * leave HOST_RESERVE_MB for everything else on the machine.
   */
  limits: protectedProcedure
    .input(z.object({ hostId: z.string().min(1).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const hostId = input?.hostId;
      const total =
        hostId && hostId !== LOCAL_HOST_ID
          ? await ctx.services.hosts
              .agentFor(hostId)
              .hostInfo()
              .then((i) => i.totalMemMb)
              .catch(() => {
                throw new TRPCError({
                  code: "PRECONDITION_FAILED",
                  message: "That host is not connected.",
                });
              })
          : hostTotalMemoryMb();
      let maxHeap = 512;
      while (estimateProcessMemoryMb(maxHeap + 512) <= total - HOST_RESERVE_MB) maxHeap += 512;
      return {
        totalMemMb: total,
        maxMemMb: Math.max(1024, maxHeap),
        defaultMemMb: Math.min(4096, Math.max(1024, Math.floor(total / 4 / 512) * 512)),
      };
    }),
});
