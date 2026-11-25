import { connect, isIP } from 'node:net';

const REQUIRED_SECURITY_HEADERS = [
  'strict-transport-security',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'content-security-policy',
];
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function usage() {
  return [
    'Usage: node apps/web/scripts/check-raw-edge-requests.mjs <loopback-http-url> --app-host <host>',
    '  [--extension-host <host> --extension-prefix </path>]',
  ].join('\n');
}

function parseArguments(argumentsList) {
  const options = { appHost: undefined, extensionHost: undefined, extensionPrefix: undefined };
  const positional = [];

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--') continue;
    if (['--app-host', '--extension-host', '--extension-prefix'].includes(argument)) {
      const value = argumentsList[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      if (argument === '--app-host') options.appHost = value;
      else if (argument === '--extension-host') options.extensionHost = value;
      else options.extensionPrefix = value;
      index += 1;
    } else if (argument.startsWith('--')) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }

  if (positional.length !== 1) throw new Error(usage());
  if (!options.appHost) throw new Error(`--app-host is required.\n${usage()}`);
  if ((options.extensionHost === undefined) !== (options.extensionPrefix === undefined)) {
    throw new Error('--extension-host and --extension-prefix must be supplied together.');
  }

  const baseUrl = new URL(positional[0]);
  const hostname = baseUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback =
    hostname === 'localhost' ||
    hostname === '::1' ||
    (isIP(hostname) === 4 && hostname.split('.')[0] === '127');
  if (
    baseUrl.protocol !== 'http:' ||
    !loopback ||
    !baseUrl.port ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.pathname !== '/' ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new Error('The server URL must be an HTTP origin on loopback with an explicit port.');
  }

  const appHost = validateHost(options.appHost, 'app host');
  if (options.extensionHost !== undefined) {
    validateHost(options.extensionHost, 'extension host');
    if (
      !options.extensionPrefix.startsWith('/') ||
      options.extensionPrefix === '/' ||
      /[?#\\%]/.test(options.extensionPrefix)
    ) {
      throw new Error('The extension prefix must be a specific plain absolute path.');
    }
    if (options.extensionPrefix.includes('//')) {
      throw new Error('The extension prefix must not contain duplicate slashes.');
    }
  }

  return {
    baseUrl,
    appHost,
    extensionHost: options.extensionHost,
    extensionPrefix: options.extensionPrefix,
    connectHost: hostname === 'localhost' ? '127.0.0.1' : hostname,
  };
}

function validateHost(value, label) {
  if (typeof value !== 'string' || !value || /[\s,/@\\?#\r\n]/.test(value)) {
    throw new Error(`The ${label} must be a valid host without a scheme or path.`);
  }
  try {
    const url = new URL(`http://${value}`);
    if (
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.host !== value.toLowerCase()
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(`The ${label} must be a valid host without a scheme or path.`);
  }
  return value;
}

function parseResponse(buffer) {
  const separator = buffer.indexOf('\r\n\r\n');
  if (separator < 0) throw new Error('The server closed the connection before sending headers.');

  const headerText = buffer.subarray(0, separator).toString('latin1');
  const [statusLine, ...headerLines] = headerText.split('\r\n');
  const statusMatch = statusLine?.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/);
  if (!statusMatch) throw new Error('The server returned an invalid HTTP status line.');

  const headers = new Map();
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
  }

  let bodyBuffer = buffer.subarray(separator + 4);
  if ((headers.get('transfer-encoding') ?? '').toLowerCase().includes('chunked')) {
    bodyBuffer = decodeChunkedBody(bodyBuffer);
  }
  const body = bodyBuffer.toString('utf8');
  let bodyCode;
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.code === 'string') bodyCode = parsed.code;
  } catch {
    // Non-JSON response bodies are expected for site and framework responses.
  }

  const csp = headers.get('content-security-policy') ?? '';
  const requestId = headers.get('x-request-id');
  const hasSecurityHeaders = REQUIRED_SECURITY_HEADERS.every((name) => headers.has(name));
  const hasCspNonce = /\bnonce-[A-Za-z0-9+/=_-]+/.test(csp);
  let handlingStage = 'indeterminate';
  let handlingEvidence = 'Response did not match a known Proxy or Next normalization signature.';
  if (statusMatch[1] === '308' && !requestId && headers.has('location')) {
    handlingStage = 'pre-proxy-normalization';
    handlingEvidence =
      'HTTP 308 without X-Request-Id; the configured Proxy does not issue redirects.';
  } else if (bodyCode === 'edge.not_found' && requestId) {
    handlingStage = 'proxy-rejection';
    handlingEvidence = 'Stable edge.not_found problem response with a server request ID.';
  } else if (hasCspNonce) {
    handlingStage = 'proxy-forwarded';
    handlingEvidence = 'The response CSP includes the nonce injected by the Proxy.';
  }

  return {
    status: Number(statusMatch[1]),
    statusText: statusMatch[2] ?? '',
    headers,
    bodyCode,
    hasSecurityHeaders,
    hasCspNonce,
    hasRequestId: requestId !== undefined,
    handlingStage,
    handlingEvidence,
  };
}

function decodeChunkedBody(body) {
  const chunks = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset);
    if (lineEnd < 0) return body;
    const sizeText = body.subarray(offset, lineEnd).toString('ascii').split(';', 1)[0].trim();
    if (!/^[0-9a-f]+$/i.test(sizeText)) return body;
    const size = Number.parseInt(sizeText, 16);
    offset = lineEnd + 2;
    if (size === 0) return Buffer.concat(chunks);
    if (body.length < offset + size + 2) return body;
    chunks.push(body.subarray(offset, offset + size));
    offset += size + 2;
  }
  return body;
}

function requestRaw({ connectHost, port, target, hostHeader }) {
  if (!target.startsWith('/') || /[\r\n\s]/.test(target)) {
    return Promise.reject(
      new Error('Raw request targets must be absolute paths without whitespace.'),
    );
  }

  return new Promise((resolve, reject) => {
    const socket = connect({ host: connectHost, port: Number(port) });
    const chunks = [];
    let receivedBytes = 0;
    let settled = false;

    function fail(error) {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    }

    socket.setTimeout(REQUEST_TIMEOUT_MS, () => fail(new Error('Raw HTTP request timed out.')));
    socket.on('error', fail);
    socket.on('connect', () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\nAccept: */*\r\n\r\n`,
      );
    });
    socket.on('data', (chunk) => {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_RESPONSE_BYTES) {
        fail(new Error('Raw HTTP response exceeded the 2 MiB safety limit.'));
        return;
      }
      chunks.push(chunk);
    });
    socket.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        resolve(parseResponse(Buffer.concat(chunks)));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function responseSummary(response) {
  const headers = Object.fromEntries(
    ['cache-control', 'location'].flatMap((name) => {
      const value = response.headers.get(name);
      if (value === undefined) return [];
      return [[name, value]];
    }),
  );

  return {
    status: response.status,
    statusText: response.statusText,
    bodyCode: response.bodyCode ?? null,
    handlingStage: response.handlingStage,
    handlingEvidence: response.handlingEvidence,
    hasSecurityHeaders: response.hasSecurityHeaders,
    securityHeaders: Object.fromEntries(
      REQUIRED_SECURITY_HEADERS.map((name) => [name, response.headers.has(name)]),
    ),
    hasCspNonce: response.hasCspNonce,
    cspKind: !response.headers.has('content-security-policy')
      ? 'missing'
      : response.hasCspNonce
        ? 'nonce'
        : 'static',
    hasRequestId: response.hasRequestId,
    headers,
  };
}

function extensionPath(prefix, suffix) {
  const base = prefix === '/' ? '' : prefix.replace(/\/$/, '');
  return `${base}/${suffix}`;
}

function outsideExtensionPath(prefix) {
  const firstSegment = prefix.split('/').filter(Boolean)[0];
  return firstSegment
    ? `/${firstSegment}__raw_outside_prefix__/__raw_edge_probe__`
    : '/__raw_edge_outside_prefix__';
}

async function run() {
  const { baseUrl, appHost, extensionHost, extensionPrefix, connectHost } = parseArguments(
    process.argv.slice(2),
  );
  const port = baseUrl.port;
  const request = (target, hostHeader) => requestRaw({ connectHost, port, target, hostHeader });

  const appHealthResponse = await request('/api/v1/health', appHost);
  const appHealth = responseSummary(appHealthResponse);
  const appHealthPassed =
    appHealthResponse.status === 200 &&
    appHealthResponse.hasSecurityHeaders &&
    appHealthResponse.hasCspNonce &&
    appHealthResponse.hasRequestId;

  const unknownHost = `unknown.invalid:${port}`;
  const unknownHostResponse = await request('/api/v1/health', unknownHost);
  const unknownHostResult = responseSummary(unknownHostResponse);
  const unknownHostPassed =
    unknownHostResponse.status === 404 &&
    unknownHostResponse.bodyCode === 'edge.not_found' &&
    unknownHostResponse.hasSecurityHeaders;

  const rawTargets = [
    { label: 'double-leading-slash', target: '//panel' },
    { label: 'encoded-dot', target: '/%2e' },
    { label: 'encoded-parent', target: '/%2e%2e/panel' },
    { label: 'encoded-parent-to-health-route', target: '/%2e%2e/api/v1/health' },
    { label: 'encoded-slash', target: '/%2f' },
    { label: 'encoded-backslash', target: '/%5c' },
    { label: 'literal-backslash', target: '/foo\\bar' },
  ];
  const rawPathResults = [];
  for (const item of rawTargets) {
    const response = await request(item.target, appHost);
    rawPathResults.push({
      label: item.label,
      requestTarget: item.target,
      ...responseSummary(response),
      contractSatisfied: response.status === 404 && response.hasSecurityHeaders,
    });
  }

  let extensionPrefixIsolation;
  let extensionPrefixPassed = true;
  if (extensionHost !== undefined && extensionPrefix !== undefined) {
    const extensionRequestPath = extensionPath(extensionPrefix, '__raw_edge_probe__');
    const normalizedExtensionRequestPath = `/%2e%2e${extensionRequestPath}`;
    const outsidePrefixPath = outsideExtensionPath(extensionPrefix);
    const cases = [
      {
        label: 'app-host-rejects-extension-prefix',
        target: extensionRequestPath,
        host: appHost,
        expectation: 'proxy-rejection',
      },
      {
        label: 'app-host-rejects-normalized-extension-prefix',
        target: normalizedExtensionRequestPath,
        host: appHost,
        expectation: 'proxy-rejection',
      },
      {
        label: 'extension-host-serves-prefix',
        target: extensionRequestPath,
        host: extensionHost,
        expectation: 'proxy-forwarded',
      },
      {
        label: 'extension-host-serves-normalized-prefix',
        target: normalizedExtensionRequestPath,
        host: extensionHost,
        expectation: 'proxy-forwarded',
      },
      {
        label: 'extension-host-rejects-outside-prefix',
        target: outsidePrefixPath,
        host: extensionHost,
        expectation: 'proxy-rejection',
      },
    ];
    const results = [];
    for (const item of cases) {
      const response = await request(item.target, item.host);
      const summary = responseSummary(response);
      const passed =
        item.expectation === 'proxy-rejection'
          ? response.status === 404 &&
            response.bodyCode === 'edge.not_found' &&
            response.hasSecurityHeaders
          : response.handlingStage === 'proxy-forwarded' && response.hasCspNonce;
      extensionPrefixPassed &&= passed;
      results.push({
        label: item.label,
        host: item.host,
        requestTarget: item.target,
        expectation: item.expectation,
        ...summary,
        passed,
      });
    }
    extensionPrefixIsolation = {
      status: extensionPrefixPassed ? 'passed' : 'failed',
      extensionHost,
      extensionPrefix,
      results,
    };
  } else {
    extensionPrefixIsolation = {
      status: 'not-exercised',
      reason:
        'The base template edgeExtensions registry is empty. Pass a registered extension host and prefix to exercise this live-server check.',
    };
  }

  const hardChecksPassed =
    appHealthPassed &&
    unknownHostPassed &&
    rawPathResults.every((result) => result.contractSatisfied);
  const acceptanceStatus = !hardChecksPassed
    ? 'failed'
    : extensionHost === undefined
      ? 'incomplete'
      : extensionPrefixPassed
        ? 'passed'
        : 'failed';
  const result = {
    check: 'w1-raw-edge-requests',
    server: { origin: baseUrl.origin, appHost, transport: 'raw-loopback-tcp' },
    diagnosticStatus: 'completed',
    acceptanceStatus,
    checks: {
      appHostHealth: { ...appHealth, passed: appHealthPassed },
      unknownHost: {
        host: unknownHost,
        requestTarget: '/api/v1/health',
        ...unknownHostResult,
        passed: unknownHostPassed,
      },
      rawPathBypasses: {
        contract: 'each request target must return 404 with all required security headers',
        results: rawPathResults,
      },
      extensionPrefixIsolation,
    },
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (acceptanceStatus !== 'passed') process.exitCode = 1;
}

try {
  await run();
} catch (error) {
  const result = {
    check: 'w1-raw-edge-requests',
    diagnosticStatus: 'failed-to-run',
    acceptanceStatus: 'failed',
    error: error instanceof Error ? error.message : 'Raw edge request check failed.',
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = 1;
}
