/**
 * Generate an idempotency key for platform-management mutations.
 *
 * The dashboard supports private-network HTTP deployments, where
 * `crypto.randomUUID()` is not required to be exposed by the browser.
 */
type WebCryptoLike = {
  randomUUID?: () => string;
  getRandomValues?: (values: Uint8Array) => Uint8Array;
};

function uuidFromBytes(bytes: Uint8Array): string {
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newPlatformRequestId(crypto: WebCryptoLike | undefined = (globalThis as { crypto?: WebCryptoLike }).crypto): string {
  try {
    if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    // Prefer random bytes if a browser exposes a broken UUID implementation.
  }
  try {
    if (typeof crypto?.getRandomValues === 'function') return uuidFromBytes(crypto.getRandomValues(new Uint8Array(16)));
  } catch {
    // A partial WebCrypto implementation must not prevent the dialog opening.
  }
  // Request IDs are deduplication keys, never authentication credentials.
  return uuidFromBytes(Uint8Array.from({length:16},()=>Math.floor(Math.random()*0x100)));
}
