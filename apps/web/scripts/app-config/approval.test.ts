import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ApprovalError,
  canonicalJson,
  createApprovalEnvelope,
  getApprovalPayloadDigest,
  parseApprovalEnvelope,
  parseTrustRegistry,
  signApprovalEnvelope,
  verifyApprovalSignatures,
  type ApprovalEnvelope,
  type TrustRegistry,
} from './approval';

type GeneratedEd25519Key = Readonly<{
  identity: string;
  privateKeyPem: string;
  publicKeyPem: string;
  fingerprintSha256: string;
}>;

function generateEd25519Key(identity: string): GeneratedEd25519Key {
  const pair = generateKeyPairSync('ed25519');
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const fingerprintSha256 = createHash('sha256')
    .update(pair.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
  return { identity, privateKeyPem, publicKeyPem, fingerprintSha256 };
}

function createRegistry(...keys: readonly GeneratedEd25519Key[]): TrustRegistry {
  const identities = Object.fromEntries(
    keys.map((key) => [
      key.identity,
      { publicKeyPem: key.publicKeyPem, fingerprintSha256: key.fingerprintSha256 },
    ]),
  );
  return parseTrustRegistry({ version: 1, identities });
}

function expectApprovalCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ApprovalError ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ApprovalError);
    expect((error as ApprovalError).code).toBe(code);
  }
}

function signatureWithIdentity(
  envelope: ApprovalEnvelope<unknown>,
  identity: string,
): ApprovalEnvelope<unknown> {
  const existing = envelope.signatures[0];
  if (existing === undefined) throw new Error('Expected an approval signature.');
  return {
    ...envelope,
    signatures: [{ identity, signature: existing.signature }],
  };
}

function fingerprint(publicKey: KeyObject): string {
  return createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

describe('app-config approval canonical payloads', () => {
  it('uses sorted keys and the domain-separated digest for deterministic equivalent payloads', () => {
    const first = { z: 3, nested: { y: true, x: 'ok' }, a: [1, null] };
    const second = { a: [1, null], nested: { x: 'ok', y: true }, z: 3 };
    const expectedCanonical = '{"a":[1,null],"nested":{"x":"ok","y":true},"z":3}';
    const expectedDigest = createHash('sha256')
      .update(
        Buffer.concat([
          Buffer.from('AISAC-BASE-APP-APP-CONFIG-APPROVAL-V1\0', 'utf8'),
          Buffer.from(expectedCanonical, 'utf8'),
        ]),
      )
      .digest('hex');

    expect(canonicalJson(first)).toBe(expectedCanonical);
    expect(getApprovalPayloadDigest(first)).toBe(expectedDigest);
    expect(getApprovalPayloadDigest(second)).toBe(expectedDigest);
  });

  it('rejects values that do not have one unambiguous JSON representation', () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const sparse = new Array(2);
    const symbolProperty = { value: 1, [Symbol('hidden')]: 2 };
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    class CustomValue {
      readonly value = 1;
    }

    for (const value of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -0,
      1n,
      sparse,
      symbolProperty,
      accessor,
      new CustomValue(),
      cycle,
    ]) {
      expect(() => canonicalJson(value)).toThrow(ApprovalError);
    }
    expect(getterCalls).toBe(0);
  });

  it('creates immutable envelopes and reparses the payload digest instead of trusting it', () => {
    const input = { operation: { key: 'legal', after: { termsVersion: '2026-11-25' } } };
    const envelope = createApprovalEnvelope(input);
    input.operation.after.termsVersion = 'mutated after envelope creation';

    expect(envelope.payload.operation.after.termsVersion).toBe('2026-11-25');
    expect(Object.isFrozen(envelope.payload)).toBe(true);
    expect(parseApprovalEnvelope(envelope)).toEqual(envelope);
    expectApprovalCode(
      () => parseApprovalEnvelope({ ...envelope, payloadSha256: '0'.repeat(64) }),
      'INVALID_APPROVAL_ENVELOPE',
    );
  });

  it('rejects changes to every signed payload field and nested field', () => {
    const key = generateEd25519Key('operator-a');
    const registry = createRegistry(key, generateEd25519Key('operator-b'));
    const payload = {
      planId: 'operation-1',
      target: { host: 'db.example.test', port: 5432 },
      checkout: { commit: 'a'.repeat(40), tree: 'b'.repeat(40) },
      operation: { key: 'legal', before: null, after: { termsVersion: '2026-11-25' } },
      preparedAt: '2026-11-25T12:00:00.000Z',
      expiresAt: '2026-11-25T12:15:00.000Z',
    };
    const signed = signApprovalEnvelope(
      createApprovalEnvelope(payload),
      key.privateKeyPem,
      registry,
    );
    const tamperedPayloads = [
      { ...payload, planId: 'operation-2' },
      { ...payload, target: { ...payload.target, host: 'other.example.test' } },
      { ...payload, target: { ...payload.target, port: 6432 } },
      { ...payload, checkout: { ...payload.checkout, commit: 'c'.repeat(40) } },
      { ...payload, checkout: { ...payload.checkout, tree: 'd'.repeat(40) } },
      { ...payload, operation: { ...payload.operation, key: 'maintenance' } },
      { ...payload, operation: { ...payload.operation, before: { termsVersion: '2025-01-01' } } },
      { ...payload, operation: { ...payload.operation, after: { termsVersion: '2026-11-26' } } },
      { ...payload, preparedAt: '2026-11-25T12:01:00.000Z' },
      { ...payload, expiresAt: '2026-11-25T12:16:00.000Z' },
    ];

    for (const tamperedPayload of tamperedPayloads) {
      expectApprovalCode(
        () => parseApprovalEnvelope({ ...signed, payload: tamperedPayload }),
        'INVALID_APPROVAL_ENVELOPE',
      );
    }
  });

  it('rejects unknown envelope and signature properties', () => {
    const key = generateEd25519Key('operator-a');
    const registry = createRegistry(key, generateEd25519Key('operator-b'));
    const signed = signApprovalEnvelope(
      createApprovalEnvelope({ planId: 'operation-1' }),
      key.privateKeyPem,
      registry,
    );

    expectApprovalCode(
      () => parseApprovalEnvelope({ ...signed, unexpected: true }),
      'INVALID_APPROVAL_ENVELOPE',
    );
    expectApprovalCode(
      () =>
        parseApprovalEnvelope({
          ...signed,
          signatures: [{ ...signed.signatures[0], unexpected: true }],
        }),
      'INVALID_APPROVAL_ENVELOPE',
    );
  });
});

describe('app-config Ed25519 approval signatures', () => {
  it('derives the signing identity from the private key and verifies two distinct signers', () => {
    const first = generateEd25519Key('operator-a');
    const second = generateEd25519Key('operator-b');
    const registry = createRegistry(first, second);
    const unsigned = createApprovalEnvelope({ operation: 'set', key: 'legal' });
    const signedBySecond = signApprovalEnvelope(unsigned, second.privateKeyPem, registry);
    expect(signedBySecond.signatures.map(({ identity }) => identity)).toEqual(['operator-b']);
    verifyApprovalSignatures(signedBySecond, registry, false);

    const fullySigned = signApprovalEnvelope(signedBySecond, first.privateKeyPem, registry);
    expect(fullySigned.signatures.map(({ identity }) => identity)).toEqual([
      'operator-b',
      'operator-a',
    ]);
    expect(() => verifyApprovalSignatures(fullySigned, registry, true)).not.toThrow();
  });

  it('accepts zero or one signature only without the two-person threshold', () => {
    const first = generateEd25519Key('operator-a');
    const registry = createRegistry(first, generateEd25519Key('operator-b'));
    const unsigned = createApprovalEnvelope({ operation: 'set' });
    const oneSignature = signApprovalEnvelope(unsigned, first.privateKeyPem, registry);

    expect(() => verifyApprovalSignatures(unsigned, registry, false)).not.toThrow();
    expect(() => verifyApprovalSignatures(oneSignature, registry, false)).not.toThrow();
    expectApprovalCode(
      () => verifyApprovalSignatures(unsigned, registry, true),
      'SIGNATURE_THRESHOLD',
    );
    expectApprovalCode(
      () => verifyApprovalSignatures(oneSignature, registry, true),
      'SIGNATURE_THRESHOLD',
    );
  });

  it('rejects three signatures and refuses a third signing operation', () => {
    const first = generateEd25519Key('operator-a');
    const second = generateEd25519Key('operator-b');
    const third = generateEd25519Key('operator-c');
    const registry = createRegistry(first, second, third);
    const twoSigned = signApprovalEnvelope(
      signApprovalEnvelope(
        createApprovalEnvelope({ operation: 'set' }),
        first.privateKeyPem,
        registry,
      ),
      second.privateKeyPem,
      registry,
    );

    expectApprovalCode(
      () => signApprovalEnvelope(twoSigned, third.privateKeyPem, registry),
      'SIGNATURE_THRESHOLD',
    );
    expectApprovalCode(
      () =>
        parseApprovalEnvelope({
          ...twoSigned,
          signatures: [...twoSigned.signatures, twoSigned.signatures[0]],
        }),
      'INVALID_APPROVAL_ENVELOPE',
    );
  });

  it('rejects invalid signatures, unknown identities, and duplicate identities', () => {
    const first = generateEd25519Key('operator-a');
    const registry = createRegistry(first, generateEd25519Key('operator-b'));
    const signed = signApprovalEnvelope(
      createApprovalEnvelope({ operation: 'set' }),
      first.privateKeyPem,
      registry,
    );
    const invalidSignature: ApprovalEnvelope<unknown> = {
      ...signed,
      signatures: [{ identity: 'operator-a', signature: Buffer.alloc(64).toString('base64') }],
    };
    const unknownIdentity = signatureWithIdentity(signed, 'operator-unknown');
    const duplicateIdentity: ApprovalEnvelope<unknown> = {
      ...signed,
      signatures: [signed.signatures[0]!, signed.signatures[0]!],
    };

    expectApprovalCode(
      () => verifyApprovalSignatures(invalidSignature, registry, false),
      'INVALID_SIGNATURE',
    );
    expectApprovalCode(
      () => verifyApprovalSignatures(unknownIdentity, registry, false),
      'UNTRUSTED_SIGNER',
    );
    expectApprovalCode(
      () => verifyApprovalSignatures(duplicateIdentity, registry, false),
      'DUPLICATE_SIGNER',
    );
  });

  it('rejects an untrusted signing key and never accepts a caller-supplied identity', () => {
    const trusted = generateEd25519Key('operator-a');
    const registry = createRegistry(trusted, generateEd25519Key('operator-b'));
    const untrusted = generateEd25519Key('operator-a');

    expectApprovalCode(
      () =>
        signApprovalEnvelope(
          createApprovalEnvelope({ operation: 'set' }),
          untrusted.privateKeyPem,
          registry,
        ),
      'UNTRUSTED_SIGNER',
    );
  });

  it('rejects two trusted labels that point to the same public key', () => {
    const first = generateEd25519Key('operator-a');
    const other = generateEd25519Key('operator-b');

    expectApprovalCode(
      () =>
        parseTrustRegistry({
          version: 1,
          identities: {
            'operator-a': {
              publicKeyPem: first.publicKeyPem,
              fingerprintSha256: first.fingerprintSha256,
            },
            'operator-alias': {
              publicKeyPem: first.publicKeyPem,
              fingerprintSha256: first.fingerprintSha256,
            },
            'operator-b': {
              publicKeyPem: other.publicKeyPem,
              fingerprintSha256: other.fingerprintSha256,
            },
          },
        }),
      'DUPLICATE_SIGNER',
    );
  });

  it('rejects non-Ed25519 keys, private keys, and mismatched fingerprints in the trust registry', () => {
    const first = generateEd25519Key('operator-a');
    const second = generateEd25519Key('operator-b');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPublicPem = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const rsaFingerprint = fingerprint(rsa.publicKey);

    expectApprovalCode(
      () =>
        parseTrustRegistry({
          version: 1,
          identities: {
            'operator-a': {
              publicKeyPem: first.publicKeyPem,
              fingerprintSha256: first.fingerprintSha256,
            },
            'operator-b': { publicKeyPem: rsaPublicPem, fingerprintSha256: rsaFingerprint },
          },
        }),
      'NON_ED25519_KEY',
    );
    expectApprovalCode(
      () =>
        parseTrustRegistry({
          version: 1,
          identities: {
            'operator-a': {
              publicKeyPem: first.privateKeyPem,
              fingerprintSha256: first.fingerprintSha256,
            },
            'operator-b': {
              publicKeyPem: second.publicKeyPem,
              fingerprintSha256: second.fingerprintSha256,
            },
          },
        }),
      'PRIVATE_KEY_IN_TRUST_REGISTRY',
    );
    expectApprovalCode(
      () =>
        parseTrustRegistry({
          version: 1,
          identities: {
            'operator-a': { publicKeyPem: first.publicKeyPem, fingerprintSha256: '0'.repeat(64) },
            'operator-b': {
              publicKeyPem: second.publicKeyPem,
              fingerprintSha256: second.fingerprintSha256,
            },
          },
        }),
      'INVALID_TRUST_REGISTRY',
    );
  });

  it('rejects duplicate private-key algorithms at signing time', () => {
    const first = generateEd25519Key('operator-a');
    const second = generateEd25519Key('operator-b');
    const registry = createRegistry(first, second);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPrivatePem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    expectApprovalCode(
      () =>
        signApprovalEnvelope(createApprovalEnvelope({ operation: 'set' }), rsaPrivatePem, registry),
      'NON_ED25519_KEY',
    );
  });
});
