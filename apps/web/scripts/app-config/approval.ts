import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

const SIGNING_DOMAIN = Buffer.from('AISAC-BASE-APP-APP-CONFIG-APPROVAL-V1\0', 'utf8');
const IDENTITY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SIGNATURE_BYTES = 64;
const MAX_CANONICAL_DEPTH = 128;

export type ApprovalSignature = Readonly<{
  identity: string;
  signature: string;
}>;

export type ApprovalEnvelope<T> = Readonly<{
  payload: T;
  payloadSha256: string;
  signatures: readonly ApprovalSignature[];
}>;

export type TrustedApprovalKey = Readonly<{
  identity: string;
  publicKey: KeyObject;
  fingerprintSha256: string;
}>;

export type TrustRegistry = ReadonlyMap<string, TrustedApprovalKey>;

export type ApprovalErrorCode =
  | 'INVALID_TRUST_REGISTRY'
  | 'INVALID_APPROVAL_ENVELOPE'
  | 'UNSUPPORTED_CANONICAL_VALUE'
  | 'UNTRUSTED_SIGNER'
  | 'DUPLICATE_SIGNER'
  | 'INVALID_SIGNATURE'
  | 'SIGNATURE_THRESHOLD'
  | 'NON_ED25519_KEY'
  | 'PRIVATE_KEY_IN_TRUST_REGISTRY'
  | 'INVALID_SIGNING_KEY';

const ERROR_MESSAGES: Record<ApprovalErrorCode, string> = {
  INVALID_TRUST_REGISTRY: 'The approval trust registry is invalid.',
  INVALID_APPROVAL_ENVELOPE: 'The approval envelope is invalid.',
  UNSUPPORTED_CANONICAL_VALUE: 'The approval payload contains an unsupported value.',
  UNTRUSTED_SIGNER: 'The signing identity is not trusted.',
  DUPLICATE_SIGNER: 'An approval identity or public key signed more than once.',
  INVALID_SIGNATURE: 'An approval signature is invalid.',
  SIGNATURE_THRESHOLD: 'Exactly two distinct trusted identities must sign the approval.',
  NON_ED25519_KEY: 'App-config approvals require Ed25519 keys.',
  PRIVATE_KEY_IN_TRUST_REGISTRY: 'The public trust registry must not contain private key material.',
  INVALID_SIGNING_KEY: 'The approval signing key is invalid.',
};

export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode;

  constructor(code: ApprovalErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'ApprovalError';
    this.code = code;
  }
}

function fail(code: ApprovalErrorCode): never {
  throw new ApprovalError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  try {
    if (Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value) as unknown;
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function ownDataEntries(
  value: Record<string, unknown>,
  errorCode: ApprovalErrorCode,
): Array<[string, unknown]> {
  let keys: PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return fail(errorCode);
  }
  if (keys.some((key) => typeof key !== 'string')) return fail(errorCode);
  const entries: Array<[string, unknown]> = [];
  for (const key of keys as string[]) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      return fail(errorCode);
    }
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      return fail(errorCode);
    }
    entries.push([key, descriptor.value as unknown]);
  }
  return entries;
}

function canonicalJsonInternal(value: unknown, active: WeakSet<object>, depth: number): string {
  if (depth > MAX_CANONICAL_DEPTH) return fail('UNSUPPORTED_CANONICAL_VALUE');
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) return fail('UNSUPPORTED_CANONICAL_VALUE');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') return fail('UNSUPPORTED_CANONICAL_VALUE');
  if (active.has(value)) return fail('UNSUPPORTED_CANONICAL_VALUE');
  active.add(value);
  try {
    if (Array.isArray(value)) {
      let ownKeys: PropertyKey[];
      try {
        if (Object.getPrototypeOf(value) !== Array.prototype)
          return fail('UNSUPPORTED_CANONICAL_VALUE');
        ownKeys = Reflect.ownKeys(value);
      } catch {
        return fail('UNSUPPORTED_CANONICAL_VALUE');
      }
      if (ownKeys.length !== value.length + 1 || ownKeys.some((key) => typeof key !== 'string')) {
        return fail('UNSUPPORTED_CANONICAL_VALUE');
      }
      const parts: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        let descriptor: PropertyDescriptor | undefined;
        try {
          descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        } catch {
          return fail('UNSUPPORTED_CANONICAL_VALUE');
        }
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          return fail('UNSUPPORTED_CANONICAL_VALUE');
        }
        parts.push(canonicalJsonInternal(descriptor.value as unknown, active, depth + 1));
      }
      let lengthDescriptor: PropertyDescriptor | undefined;
      try {
        lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      } catch {
        return fail('UNSUPPORTED_CANONICAL_VALUE');
      }
      if (
        lengthDescriptor === undefined ||
        lengthDescriptor.enumerable ||
        !('value' in lengthDescriptor)
      ) {
        return fail('UNSUPPORTED_CANONICAL_VALUE');
      }
      return `[${parts.join(',')}]`;
    }

    let prototype: unknown;
    try {
      prototype = Object.getPrototypeOf(value) as unknown;
    } catch {
      return fail('UNSUPPORTED_CANONICAL_VALUE');
    }
    if (prototype !== Object.prototype && prototype !== null)
      return fail('UNSUPPORTED_CANONICAL_VALUE');

    let ownKeys: PropertyKey[];
    try {
      ownKeys = Reflect.ownKeys(value);
    } catch {
      return fail('UNSUPPORTED_CANONICAL_VALUE');
    }
    if (ownKeys.some((key) => typeof key !== 'string')) return fail('UNSUPPORTED_CANONICAL_VALUE');
    const keys = (ownKeys as string[]).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const parts = keys.map((key) => {
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        return fail('UNSUPPORTED_CANONICAL_VALUE');
      }
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        return fail('UNSUPPORTED_CANONICAL_VALUE');
      }
      return `${JSON.stringify(key)}:${canonicalJsonInternal(descriptor.value as unknown, active, depth + 1)}`;
    });
    return `{${parts.join(',')}}`;
  } finally {
    active.delete(value);
  }
}

/** Serialize JSON values with sorted object keys and reject ambiguous JavaScript values. */
export function canonicalJson(value: unknown): string {
  return canonicalJsonInternal(value, new WeakSet<object>(), 0);
}

function signingBytes(payload: unknown): Buffer {
  return Buffer.concat([SIGNING_DOMAIN, Buffer.from(canonicalJson(payload), 'utf8')]);
}

export function getApprovalPayloadDigest(payload: unknown): string {
  return createHash('sha256').update(signingBytes(payload)).digest('hex');
}

function cloneFrozenJson<T>(value: T): T {
  const canonical = canonicalJson(value);
  const clone: unknown = JSON.parse(canonical);
  return deepFreeze(clone) as T;
}

function deepFreeze(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const child of value) deepFreeze(child as unknown);
  } else {
    for (const child of Object.values(value)) deepFreeze(child as unknown);
  }
  return Object.freeze(value);
}

function isExactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  errorCode: ApprovalErrorCode,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const entries = ownDataEntries(value, errorCode);
  return (
    entries.length === requiredKeys.length &&
    requiredKeys.every((key) => entries.some(([entryKey]) => entryKey === key))
  );
}

function isCanonicalBase64Signature(value: unknown): value is string {
  if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.byteLength === SIGNATURE_BYTES && bytes.toString('base64') === value;
}

export function parseApprovalEnvelope(value: unknown): ApprovalEnvelope<unknown> {
  if (
    !isExactRecord(value, ['payload', 'payloadSha256', 'signatures'], 'INVALID_APPROVAL_ENVELOPE')
  ) {
    return fail('INVALID_APPROVAL_ENVELOPE');
  }
  const entries = ownDataEntries(value, 'INVALID_APPROVAL_ENVELOPE');
  const envelope = Object.fromEntries(entries) as Record<string, unknown>;
  const payloadSha256 = envelope.payloadSha256;
  const signaturesValue = envelope.signatures;
  if (typeof payloadSha256 !== 'string' || !SHA256_PATTERN.test(payloadSha256)) {
    return fail('INVALID_APPROVAL_ENVELOPE');
  }
  if (!Array.isArray(signaturesValue)) return fail('INVALID_APPROVAL_ENVELOPE');
  let signaturesPrototype: unknown;
  let signatureKeys: PropertyKey[];
  try {
    signaturesPrototype = Object.getPrototypeOf(signaturesValue) as unknown;
    signatureKeys = Reflect.ownKeys(signaturesValue);
  } catch {
    return fail('INVALID_APPROVAL_ENVELOPE');
  }
  if (
    signaturesPrototype !== Array.prototype ||
    signaturesValue.length > 2 ||
    signatureKeys.length !== signaturesValue.length + 1 ||
    signatureKeys.some((key) => typeof key !== 'string')
  ) {
    return fail('INVALID_APPROVAL_ENVELOPE');
  }
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(signaturesValue, 'length');
  } catch {
    return fail('INVALID_APPROVAL_ENVELOPE');
  }
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.enumerable ||
    !('value' in lengthDescriptor)
  ) {
    return fail('INVALID_APPROVAL_ENVELOPE');
  }
  const signatures: ApprovalSignature[] = [];
  for (let index = 0; index < signaturesValue.length; index += 1) {
    let signatureDescriptor: PropertyDescriptor | undefined;
    try {
      signatureDescriptor = Object.getOwnPropertyDescriptor(signaturesValue, String(index));
    } catch {
      return fail('INVALID_APPROVAL_ENVELOPE');
    }
    if (
      signatureDescriptor === undefined ||
      !signatureDescriptor.enumerable ||
      !('value' in signatureDescriptor)
    ) {
      return fail('INVALID_APPROVAL_ENVELOPE');
    }
    const signatureValue: unknown = signatureDescriptor.value as unknown;
    if (!isExactRecord(signatureValue, ['identity', 'signature'], 'INVALID_APPROVAL_ENVELOPE')) {
      return fail('INVALID_APPROVAL_ENVELOPE');
    }
    const signatureEntries = ownDataEntries(signatureValue, 'INVALID_APPROVAL_ENVELOPE');
    const parsedSignature = Object.fromEntries(signatureEntries) as Record<string, unknown>;
    if (
      typeof parsedSignature.identity !== 'string' ||
      !IDENTITY_PATTERN.test(parsedSignature.identity) ||
      !isCanonicalBase64Signature(parsedSignature.signature)
    ) {
      return fail('INVALID_APPROVAL_ENVELOPE');
    }
    signatures.push(
      Object.freeze({
        identity: parsedSignature.identity,
        signature: parsedSignature.signature,
      }),
    );
  }
  const payload = cloneFrozenJson(envelope.payload);
  if (getApprovalPayloadDigest(payload) !== payloadSha256) return fail('INVALID_APPROVAL_ENVELOPE');
  return Object.freeze({
    payload,
    payloadSha256,
    signatures: Object.freeze(signatures),
  });
}

export function createApprovalEnvelope<T>(payload: T): ApprovalEnvelope<T> {
  const canonicalPayload = cloneFrozenJson(payload);
  return Object.freeze({
    payload: canonicalPayload,
    payloadSha256: getApprovalPayloadDigest(canonicalPayload),
    signatures: Object.freeze([]),
  });
}

function keyFingerprint(publicKey: KeyObject): string {
  return createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

function privateKeyMaterialPresent(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value);
}

function hasPrivateKeyField(value: unknown, pattern: RegExp): boolean {
  if (!isRecord(value)) return false;
  try {
    return Reflect.ownKeys(value).some((key) => typeof key === 'string' && pattern.test(key));
  } catch {
    return false;
  }
}

export function parseTrustRegistry(value: unknown): TrustRegistry {
  const privateFieldPattern = /(?:private|secret).*key|key.*(?:private|secret)/i;
  if (hasPrivateKeyField(value, privateFieldPattern)) {
    return fail('PRIVATE_KEY_IN_TRUST_REGISTRY');
  }
  if (!isExactRecord(value, ['version', 'identities'], 'INVALID_TRUST_REGISTRY')) {
    return fail('INVALID_TRUST_REGISTRY');
  }
  const registryEntries = ownDataEntries(value, 'INVALID_TRUST_REGISTRY');
  const record = Object.fromEntries(registryEntries) as Record<string, unknown>;
  if (record.version !== 1 || !isRecord(record.identities)) return fail('INVALID_TRUST_REGISTRY');
  const identityEntries = ownDataEntries(record.identities, 'INVALID_TRUST_REGISTRY');
  if (identityEntries.length < 2 || identityEntries.length > 64)
    return fail('INVALID_TRUST_REGISTRY');

  const trustedKeys = new Map<string, TrustedApprovalKey>();
  const fingerprints = new Set<string>();
  for (const [identity, entryValue] of identityEntries) {
    if (hasPrivateKeyField(entryValue, privateFieldPattern)) {
      return fail('PRIVATE_KEY_IN_TRUST_REGISTRY');
    }
    if (
      !IDENTITY_PATTERN.test(identity) ||
      !isExactRecord(entryValue, ['publicKeyPem', 'fingerprintSha256'], 'INVALID_TRUST_REGISTRY')
    ) {
      return fail('INVALID_TRUST_REGISTRY');
    }
    const entryEntries = ownDataEntries(entryValue, 'INVALID_TRUST_REGISTRY');
    const entry = Object.fromEntries(entryEntries) as Record<string, unknown>;
    if (
      typeof entry.publicKeyPem !== 'string' ||
      entry.publicKeyPem.length > 4096 ||
      privateKeyMaterialPresent(entry.publicKeyPem) ||
      !entry.publicKeyPem.trimStart().startsWith('-----BEGIN PUBLIC KEY-----') ||
      typeof entry.fingerprintSha256 !== 'string' ||
      !SHA256_PATTERN.test(entry.fingerprintSha256)
    ) {
      if (privateKeyMaterialPresent(entry.publicKeyPem))
        return fail('PRIVATE_KEY_IN_TRUST_REGISTRY');
      return fail('INVALID_TRUST_REGISTRY');
    }

    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey(entry.publicKeyPem);
    } catch {
      return fail('INVALID_TRUST_REGISTRY');
    }
    if (publicKey.asymmetricKeyType !== 'ed25519' || publicKey.type !== 'public') {
      return fail('NON_ED25519_KEY');
    }
    const fingerprintSha256 = keyFingerprint(publicKey);
    if (fingerprintSha256 !== entry.fingerprintSha256) return fail('INVALID_TRUST_REGISTRY');
    if (fingerprints.has(fingerprintSha256)) return fail('DUPLICATE_SIGNER');
    fingerprints.add(fingerprintSha256);
    trustedKeys.set(identity, Object.freeze({ identity, publicKey, fingerprintSha256 }));
  }
  return trustedKeys;
}

function validateTrustRegistry(value: TrustRegistry): TrustRegistry {
  if (!(value instanceof Map)) return fail('INVALID_TRUST_REGISTRY');
  const seenFingerprints = new Set<string>();
  const entries = new Map<string, TrustedApprovalKey>();
  for (const [identity, trustedValue] of value.entries()) {
    if (
      typeof identity !== 'string' ||
      !IDENTITY_PATTERN.test(identity) ||
      !isExactRecord(
        trustedValue,
        ['identity', 'publicKey', 'fingerprintSha256'],
        'INVALID_TRUST_REGISTRY',
      )
    ) {
      return fail('INVALID_TRUST_REGISTRY');
    }
    const trustedEntries = Object.fromEntries(
      ownDataEntries(trustedValue, 'INVALID_TRUST_REGISTRY'),
    ) as Record<string, unknown>;
    if (trustedEntries.identity !== identity) return fail('INVALID_TRUST_REGISTRY');
    const publicKey: unknown = trustedEntries.publicKey;
    if (
      typeof publicKey !== 'object' ||
      publicKey === null ||
      !('asymmetricKeyType' in publicKey) ||
      !('type' in publicKey) ||
      publicKey.asymmetricKeyType !== 'ed25519' ||
      publicKey.type !== 'public'
    ) {
      return fail('INVALID_TRUST_REGISTRY');
    }
    const keyObject = publicKey as KeyObject;
    let computedFingerprint: string;
    try {
      computedFingerprint = keyFingerprint(keyObject);
    } catch {
      return fail('INVALID_TRUST_REGISTRY');
    }
    if (computedFingerprint !== trustedEntries.fingerprintSha256)
      return fail('INVALID_TRUST_REGISTRY');
    if (seenFingerprints.has(computedFingerprint)) return fail('DUPLICATE_SIGNER');
    seenFingerprints.add(computedFingerprint);
    entries.set(
      identity,
      Object.freeze({
        identity,
        publicKey: keyObject,
        fingerprintSha256: computedFingerprint,
      }),
    );
  }
  return entries;
}

export function signApprovalEnvelope<T>(
  envelopeInput: ApprovalEnvelope<T>,
  privateKeyPem: string,
  trustRegistryInput: TrustRegistry,
): ApprovalEnvelope<T> {
  const envelope = parseApprovalEnvelope(envelopeInput);
  const trustRegistry = validateTrustRegistry(trustRegistryInput);
  verifyApprovalSignatures(envelope, trustRegistry, false);
  if (typeof privateKeyPem !== 'string' || privateKeyPem.length === 0)
    return fail('INVALID_SIGNING_KEY');

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    return fail('INVALID_SIGNING_KEY');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519' || privateKey.type !== 'private') {
    return fail('NON_ED25519_KEY');
  }
  const fingerprintSha256 = keyFingerprint(createPublicKey(privateKey));
  const matchingIdentity = [...trustRegistry.values()].find(
    (trusted) => trusted.fingerprintSha256 === fingerprintSha256,
  );
  if (matchingIdentity === undefined) return fail('UNTRUSTED_SIGNER');
  if (
    envelope.signatures.some(
      (signature) =>
        signature.identity === matchingIdentity.identity ||
        trustRegistry.get(signature.identity)?.fingerprintSha256 === fingerprintSha256,
    )
  ) {
    return fail('DUPLICATE_SIGNER');
  }
  if (envelope.signatures.length >= 2) return fail('SIGNATURE_THRESHOLD');

  const signature = cryptoSign(null, signingBytes(envelope.payload), privateKey).toString('base64');
  return Object.freeze({
    payload: envelope.payload as T,
    payloadSha256: envelope.payloadSha256,
    signatures: Object.freeze([
      ...envelope.signatures,
      Object.freeze({ identity: matchingIdentity.identity, signature }),
    ]),
  });
}

export function verifyApprovalSignatures<T>(
  envelopeInput: ApprovalEnvelope<T>,
  trustRegistryInput: TrustRegistry,
  requireTwo: boolean,
): void {
  const envelope = parseApprovalEnvelope(envelopeInput);
  const trustRegistry = validateTrustRegistry(trustRegistryInput);
  if (requireTwo && envelope.signatures.length !== 2) return fail('SIGNATURE_THRESHOLD');

  const identities = new Set<string>();
  const fingerprints = new Set<string>();
  const message = signingBytes(envelope.payload);
  for (const approval of envelope.signatures) {
    const trusted = trustRegistry.get(approval.identity);
    if (trusted === undefined) return fail('UNTRUSTED_SIGNER');
    if (identities.has(approval.identity) || fingerprints.has(trusted.fingerprintSha256)) {
      return fail('DUPLICATE_SIGNER');
    }
    const signature = Buffer.from(approval.signature, 'base64');
    const valid = (() => {
      try {
        return cryptoVerify(null, message, trusted.publicKey, signature);
      } catch {
        return false;
      }
    })();
    if (!valid) return fail('INVALID_SIGNATURE');
    identities.add(approval.identity);
    fingerprints.add(trusted.fingerprintSha256);
  }
  if (requireTwo && identities.size !== 2) return fail('SIGNATURE_THRESHOLD');
}
