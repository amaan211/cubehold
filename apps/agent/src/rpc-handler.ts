import { RPC_METHODS, type RpcMethod, type RpcRequest } from "./protocol.js";
import type { AgentApi } from "./types.js";

/**
 * Run one RPC request against an agent. JSON has no `undefined`, so an
 * omitted optional argument arrives as `null`; map it back so default
 * parameters apply (a `null` maxBytes once made every file look too large).
 */
export async function dispatchRpc(agent: AgentApi, req: RpcRequest): Promise<unknown> {
  if (!(RPC_METHODS as readonly string[]).includes(req.method)) {
    throw new Error(`unknown method ${req.method}`);
  }
  const params = (Array.isArray(req.params) ? req.params : []).map((p) =>
    p === null ? undefined : p,
  );
  const fn = agent[req.method as RpcMethod] as (...args: unknown[]) => Promise<unknown>;
  return fn.apply(agent, params);
}
