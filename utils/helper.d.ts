export declare function bytesToBase64(bytes: Uint8Array): string;
export declare function base64ToBytes(base64: string): Uint8Array;
export declare function encodeWireBody(body: unknown): unknown;
export declare function decodeWireBody(body: unknown): unknown;
export declare function errorFromUnknown(error: unknown, fallback: string): Error;
export declare function abortError(signal?: AbortSignal): Error;
export declare function countIceCandidates(sdp: string | undefined): number;
//# sourceMappingURL=helper.d.ts.map