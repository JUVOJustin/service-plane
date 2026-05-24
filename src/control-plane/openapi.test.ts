import { describe, expect, it } from 'vitest';
import { swaggerUiHtml } from './openapi.js';

describe('control-plane OpenAPI helpers', () => {
  it('escapes Swagger UI path strings for script context', () => {
    const html = swaggerUiHtml({
      openApiPath: '</script><script>alert(1)</script>',
      title: '<Service Plane>',
    });

    expect(html).toContain('&lt;Service Plane&gt;');
    expect(html).toContain('"\\u003c/script>\\u003cscript>alert(1)\\u003c/script>"');
    expect(html).not.toContain('</script><script>alert(1)</script>');
  });
});
