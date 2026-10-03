import { createFileRoute } from "@tanstack/react-router";
import { Console } from "@/components/console";

export const Route = createFileRoute("/_app/servers/$id/console")({
  component: () => (
    <Console serverId={Route.useParams().id} heightClass="h-[calc(100dvh-22rem)] min-h-80" />
  ),
});
