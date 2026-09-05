import { CapabilityAuthError } from './errors.js';

/**
 * Reads the credential behind one `Authorization` scheme. Every Service Plane scheme parses here so
 * the callers cannot drift on whitespace, scheme case, or trailing tokens.
 */
export function credentialFromAuthorization(request: Request, scheme: string, messages: { invalid: string; missing: string }): string {
  const authorization = request.headers.get('authorization')?.trim();
  if (!authorization) throw new CapabilityAuthError(messages.missing, 401);
  const parts = authorization.split(/\s+/u);
  const [presentedScheme, credential] = parts;
  if (parts.length !== 2 || presentedScheme?.toLowerCase() !== scheme.toLowerCase() || !credential) {
    throw new CapabilityAuthError(messages.invalid, 401);
  }
  return credential;
}
