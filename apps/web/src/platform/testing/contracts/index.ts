import * as z from 'zod';

import type {
  AuthorizationPolicy,
  AuthorizationRequest,
  AuthorizationDecision,
} from '../../authorization/types';
import type {
  AccountDeletionPolicy,
  EntitlementsReader,
  EmailSender,
  OverridablePorts,
} from '../../extensions/ports';

export type PortContractSuite =
  | {
      readonly port: 'EntitlementsReader';
      readonly run: (port: EntitlementsReader) => Promise<void>;
    }
  | {
      readonly port: 'AccountDeletionPolicy';
      readonly run: (port: AccountDeletionPolicy) => Promise<void>;
    }
  | { readonly port: 'EmailSender'; readonly run: (port: EmailSender) => Promise<void> }
  | {
      readonly port: 'AuthorizationPolicies';
      readonly run: (port: OverridablePorts['AuthorizationPolicies']) => Promise<void>;
    };

export async function runRegisteredPortContracts(
  overrides: Partial<OverridablePorts>,
  suites: readonly PortContractSuite[],
): Promise<void> {
  for (const portName of Object.keys(overrides) as (keyof OverridablePorts)[]) {
    const suite = suites.find((candidate) => candidate.port === portName);
    if (!suite) throw new Error(`Missing contract suite for extension port ${portName}.`);
    switch (portName) {
      case 'EntitlementsReader':
        await (suite as Extract<PortContractSuite, { port: 'EntitlementsReader' }>).run(
          overrides.EntitlementsReader!,
        );
        break;
      case 'AccountDeletionPolicy':
        await (suite as Extract<PortContractSuite, { port: 'AccountDeletionPolicy' }>).run(
          overrides.AccountDeletionPolicy!,
        );
        break;
      case 'EmailSender':
        await (suite as Extract<PortContractSuite, { port: 'EmailSender' }>).run(
          overrides.EmailSender!,
        );
        break;
      case 'AuthorizationPolicies':
        await (suite as Extract<PortContractSuite, { port: 'AuthorizationPolicies' }>).run(
          overrides.AuthorizationPolicies!,
        );
        break;
    }
  }
}

export async function assertEntitlementsFailClosed(
  readWhenProviderFails: () => Promise<Awaited<ReturnType<EntitlementsReader['read']>>>,
): Promise<void> {
  let snapshot: Awaited<ReturnType<EntitlementsReader['read']>>;
  try {
    snapshot = await readWhenProviderFails();
  } catch {
    return;
  }
  if (snapshot.entitlements.length > 0) {
    throw new Error('EntitlementsReader returned access after a provider failure.');
  }
}

export async function assertAccountDeletionPolicyContract(
  policy: AccountDeletionPolicy,
  input: { readonly userId: string; readonly correlationId: string },
): Promise<void> {
  const outcome = await policy.request({ ...input, channel: 'app' });
  if (outcome.status === 'scheduled') {
    const pending = await policy.getPending({ userId: input.userId });
    if (!pending || pending.scheduledFor.getTime() !== outcome.scheduledFor.getTime()) {
      throw new Error('Scheduled deletion must be returned by getPending.');
    }
  }
  const cancel = await policy.cancel(input);
  if (
    cancel.status === 'cancelled' &&
    (await policy.getPending({ userId: input.userId })) !== null
  ) {
    throw new Error('A cancelled deletion must no longer be pending.');
  }
}

export async function assertEmailSenderContract(
  sender: EmailSender,
  input: Parameters<EmailSender['send']>[0],
): Promise<void> {
  await sender.send(input);
}

export async function assertAuthorizationPolicyContract(
  policy: AuthorizationPolicy,
  request: AuthorizationRequest,
): Promise<void> {
  let decision: AuthorizationDecision;
  try {
    decision = await policy(request);
  } catch {
    throw new Error('AuthorizationPolicy must return a deny decision instead of throwing.');
  }
  if (
    typeof decision !== 'object' ||
    decision === null ||
    (decision.allow !== true &&
      !(
        decision.allow === false &&
        [401, 403, 404].includes(decision.status) &&
        typeof decision.code === 'string'
      ))
  ) {
    throw new Error('AuthorizationPolicy returned an invalid decision.');
  }
}

export async function assertExportIsolation(input: {
  readonly schema: z.ZodType;
  readonly userA: string;
  readonly userB: string;
  readonly collect: (userId: string) => Promise<unknown>;
  readonly userAMarkers: readonly string[];
  readonly userBMarkers: readonly string[];
}): Promise<void> {
  const exportedForA = JSON.stringify(input.schema.parse(await input.collect(input.userA)));
  const exportedForB = JSON.stringify(input.schema.parse(await input.collect(input.userB)));
  for (const marker of input.userBMarkers) {
    if (marker && exportedForA.includes(marker))
      throw new Error('Export for user A contains data from user B.');
  }
  for (const marker of input.userAMarkers) {
    if (marker && exportedForB.includes(marker))
      throw new Error('Export for user B contains data from user A.');
  }
}

export type ExportIsolationSuite = {
  readonly sectionName: string;
  readonly run: () => Promise<void>;
};

export async function runExportIsolationContracts(
  sectionNames: readonly string[],
  suites: readonly ExportIsolationSuite[],
): Promise<void> {
  for (const sectionName of sectionNames) {
    const suite = suites.find((candidate) => candidate.sectionName === sectionName);
    if (!suite) throw new Error(`Missing export isolation contract for section ${sectionName}.`);
    await suite.run();
  }
}
