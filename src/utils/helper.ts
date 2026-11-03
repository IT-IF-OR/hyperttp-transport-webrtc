import { WEBRTC_BYTES_MARKER, type EncodedWebRtcBytes } from "../types/types.js";

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeWireBody(body: unknown): unknown {
  let bytes: Uint8Array | undefined;

  if (body instanceof Uint8Array) {
    bytes = body;
  } else if (body instanceof ArrayBuffer) {
    bytes = new Uint8Array(body);
  } else if (ArrayBuffer.isView(body)) {
    bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }

  if (!bytes) return body;

  const encoded: EncodedWebRtcBytes = {
    [WEBRTC_BYTES_MARKER]: true,
    base64: bytesToBase64(bytes),
  };

  return encoded;
}

export function decodeWireBody(body: unknown): unknown {
  if (typeof body !== "object" || body === null || !(WEBRTC_BYTES_MARKER in body)) {
    return body;
  }

  const encoded = body as Partial<EncodedWebRtcBytes>;
  if (encoded[WEBRTC_BYTES_MARKER] !== true || typeof encoded.base64 !== "string") {
    return body;
  }

  return base64ToBytes(encoded.base64);
}

export function errorFromUnknown(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

export function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new Error("WebRTC operation aborted");
}

export function countIceCandidates(sdp: string | undefined): number {
  return sdp ? (sdp.match(/^a=candidate:/gm) ?? []).length : 0;
}
