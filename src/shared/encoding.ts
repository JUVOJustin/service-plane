/** Unpadded base64url, the alphabet JOSE values and Service Plane digests are written in. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** SHA-256 over a byte view, copied first so a view into a larger buffer digests only itself. */
export async function sha256Base64Url(value: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}
