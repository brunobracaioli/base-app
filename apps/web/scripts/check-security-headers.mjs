import { strict as assert } from 'node:assert';

const argumentsList = process.argv.slice(2);
const inputUrl =
  (argumentsList[0] === '--' ? argumentsList[1] : argumentsList[0]) ??
  process.env.SECURITY_HEADERS_BASE_URL;
if (!inputUrl) {
  process.stderr.write('Usage: pnpm --filter web headers:check -- <base-url>\n');
  process.exitCode = 2;
} else {
  const baseUrl = new URL(inputUrl);
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    process.stderr.write('The base URL must use HTTP or HTTPS.\n');
    process.exitCode = 2;
  } else {
    const requiredHeaders = [
      'strict-transport-security',
      'x-content-type-options',
      'x-frame-options',
      'referrer-policy',
      'content-security-policy',
    ];

    async function request(path) {
      const response = await fetch(new URL(path, baseUrl), { redirect: 'manual' });
      assert.ok(
        response.status >= 200 && response.status < 400,
        `${path} returned ${response.status}`,
      );
      for (const header of requiredHeaders) {
        assert.ok(response.headers.has(header), `${path} is missing ${header}`);
      }
      const csp = response.headers.get('content-security-policy') ?? '';
      assert.ok(csp.includes('default-src'), `${path} has an invalid CSP`);
      assert.ok(
        !/\b(?:unsafe-inline|unsafe-eval|data:|blob:|\*)\b/i.test(csp),
        `${path} has an unsafe CSP source`,
      );
      return response;
    }

    try {
      const api = await request('/api/v1/health');
      assert.equal(api.status, 200, '/api/v1/health must return 200');
      assert.ok(api.headers.has('x-request-id'), '/api/v1/health is missing X-Request-Id');

      const page = await request('/');
      const html = await page.text();
      const pageCsp = page.headers.get('content-security-policy') ?? '';
      const nonce = pageCsp.match(/'nonce-([^']+)'/)?.[1];
      assert.ok(nonce, 'The root page CSP did not include a per-request nonce');
      assert.ok(
        html.includes(`nonce="${nonce}"`),
        'Next.js inline scripts did not use the response CSP nonce',
      );
      const assetMatch = html.match(
        /(?:src|href)="([^"]*\/_next\/static\/[^"]+\.js(?:\?[^"]*)?)"/i,
      );
      assert.ok(assetMatch?.[1], 'The root page did not expose a Next.js static JavaScript asset');
      const assetUrl = new URL(assetMatch[1], baseUrl);
      const asset = await request(`${assetUrl.pathname}${assetUrl.search}`);

      for (const [path, response] of [
        ['/api/v1/health', api],
        ['/', page],
        [assetUrl.pathname, asset],
      ]) {
        const csp = response.headers.get('content-security-policy') ?? '';
        assert.ok(csp.includes('nonce-'), `${path} is missing the per-request CSP nonce`);
      }

      process.stdout.write(
        JSON.stringify({
          status: 'passed',
          checked: ['/api/v1/health', '/', assetUrl.pathname],
        }) + '\n',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Security header check failed.';
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
  }
}
