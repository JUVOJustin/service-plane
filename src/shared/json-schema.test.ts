import { describe, expect, it } from 'vitest';
import { inlineJsonSchemaRoot } from './json-schema.js';

describe('JSON Schema root refs', () => {
  it('inlines an own local target and preserves root metadata', () => {
    expect(
      inlineJsonSchemaRoot({
        $defs: { item: { properties: { id: { type: 'string' } }, type: 'object' } },
        $id: 'urn:test:item',
        $ref: '#/$defs/item',
      }),
    ).toMatchObject({
      $defs: { item: { properties: { id: { type: 'string' } }, type: 'object' } },
      $id: 'urn:test:item',
      properties: { id: { type: 'string' } },
      type: 'object',
    });
  });

  it('does not resolve inherited object properties as JSON Pointer targets', () => {
    const schema = { $ref: '#/constructor/prototype' };

    expect(inlineJsonSchemaRoot(schema)).toBe(schema);
  });
});
