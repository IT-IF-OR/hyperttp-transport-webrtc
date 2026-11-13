import type { WebRtcSignalingHandler } from "./webrtc.js";
/** Structural subset of a HyperServer REST route context. */
export interface WebRtcRestSignalingRequest {
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string | string[]>>;
    readonly query: Readonly<Record<string, string | string[]>>;
    readonly body?: unknown;
    readonly context: {
        readonly signal: AbortSignal;
    };
}
/** Adapt a signaling handler directly to HyperServer REST routes. */
export declare function createWebRtcRestSignalingHandler(signaling: WebRtcSignalingHandler): (request: WebRtcRestSignalingRequest) => Promise<{
    status: number;
    headers: Record<string, string>;
    body?: unknown;
}>;
//# sourceMappingURL=rest-signaling.d.ts.map