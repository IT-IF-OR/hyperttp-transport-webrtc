import type { WebRtcSignalingHandler } from "./webrtc.js";

/** Structural subset of a HyperServer REST route context. */
export interface WebRtcRestSignalingRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[]>>;
  readonly query: Readonly<Record<string, string | string[]>>;
  readonly body?: unknown;
  readonly context: { readonly signal: AbortSignal };
}

/** Adapt a signaling handler directly to HyperServer REST routes. */
export function createWebRtcRestSignalingHandler(signaling: WebRtcSignalingHandler) {
  return async (
    request: WebRtcRestSignalingRequest,
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body?: unknown;
  }> => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(request.query)) {
      for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
    }
    const suffix = query.toString();
    const response = await signaling.handle({
      protocol: "webrtc",
      method: request.method,
      url: suffix ? `${request.path}?${suffix}` : request.path,
      headers: request.headers,
      body: request.body,
      signal: request.context.signal,
    });
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) {
      headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    const contentType = Object.entries(headers).find(
      ([key]) => key.toLowerCase() === "content-type",
    )?.[1];
    const body =
      typeof response.body === "string" && contentType?.includes("application/json")
        ? JSON.parse(response.body)
        : response.body === ""
          ? undefined
          : response.body;
    return { status: response.status, headers, body };
  };
}
