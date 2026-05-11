import { describe, expect, it } from 'vitest';
import { ServicePlaneError } from './errors.js';
import { defineSecrets } from './secrets.js';

describe('defineSecrets', () => {
  it('parses string and JWK secrets and surfaces typed values', () => {
    const secrets = defineSecrets({
      STS_PRIVATE_KEY_JWK: 'jwk',
      SERVICE_AUTH_TOKEN: 'string',
      OPTIONAL_THING: { kind: 'json', optional: true },
    });

    const env = {
      STS_PRIVATE_KEY_JWK: '{"kty":"EC","crv":"P-256","x":"a","y":"b","d":"c"}',
      SERVICE_AUTH_TOKEN: 'super-secret',
    };
    const values = secrets.validate(env);
    expect(values.STS_PRIVATE_KEY_JWK).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(values.SERVICE_AUTH_TOKEN).toBe('super-secret');
    expect(values.OPTIONAL_THING).toBeUndefined();
    expect(secrets.schema).toEqual({
      STS_PRIVATE_KEY_JWK: 'jwk',
      SERVICE_AUTH_TOKEN: 'string',
      OPTIONAL_THING: { kind: 'json', optional: true },
    });
  });

  it('reports every missing or invalid secret in a single error', () => {
    const secrets = defineSecrets({
      STS_PRIVATE_KEY_JWK: 'jwk',
      SERVICE_AUTH_TOKEN: 'string',
      EXTRA_JSON: 'json',
    });

    let error: unknown;
    try {
      secrets.validate({
        STS_PRIVATE_KEY_JWK: 'not-json',
        EXTRA_JSON: '{not valid}',
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ServicePlaneError);
    const message = (error as Error).message;
    expect(message).toContain('SERVICE_AUTH_TOKEN');
    expect(message).toContain('STS_PRIVATE_KEY_JWK');
    expect(message).toContain('EXTRA_JSON');
  });

  it('rejects JWK secrets that are not JWK-shaped JSON', () => {
    const secrets = defineSecrets({ STS_PRIVATE_KEY_JWK: 'jwk' });
    expect(() => secrets.validate({ STS_PRIVATE_KEY_JWK: '{"foo":"bar"}' })).toThrowError(/expected JWK object/);
  });

  it('treats empty strings as missing for required secrets', () => {
    const secrets = defineSecrets({ A: 'string' });
    expect(() => secrets.validate({ A: '' })).toThrowError(/missing required secrets: A/);
  });
});
