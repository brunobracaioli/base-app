import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const ReviewerSchema = z
  .object({
    type: z.enum(['User', 'Team']),
    reviewer: z.object({ id: z.number().int().positive() }).passthrough(),
  })
  .passthrough();

const ProtectionRuleSchema = z
  .object({
    type: z.string(),
    prevent_self_review: z.boolean().optional(),
    reviewers: z.array(ReviewerSchema).optional(),
  })
  .passthrough();

const EnvironmentSchema = z
  .object({
    name: z.string().min(1),
    protection_rules: z.array(ProtectionRuleSchema).default([]),
    deployment_branch_policy: z
      .object({
        protected_branches: z.boolean(),
        custom_branch_policies: z.boolean(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

const BranchPolicySchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1),
    type: z.enum(['branch', 'tag']).optional(),
  })
  .passthrough();

const RulesetRuleSchema = z
  .object({
    type: z.string(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const BypassActorSchema = z
  .object({
    actor_id: z.number().int().nullable().optional(),
    actor_type: z.string(),
    bypass_mode: z.string(),
  })
  .passthrough();

const RulesetSchema = z
  .object({
    name: z.string().min(1),
    target: z.enum(['branch', 'tag', 'push']),
    enforcement: z.enum(['active', 'disabled', 'evaluate']),
    conditions: z
      .object({
        ref_name: z
          .object({
            include: z.array(z.string()),
            exclude: z.array(z.string()).optional().default([]),
          })
          .optional(),
      })
      .nullable()
      .optional(),
    rules: z.array(RulesetRuleSchema).default([]),
    bypass_actors: z.array(BypassActorSchema).optional(),
  })
  .passthrough();

const RulesetSummarySchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().min(1),
    target: z.enum(['branch', 'tag', 'push']),
  })
  .passthrough();

const ManualConditionSchema = z.enum(['ruleset-bypass-actors', 'environment-policy-type']);

const BaselineSchema = z
  .object({
    schemaVersion: z.literal(1),
    environments: z.array(
      z
        .object({
          name: z.string().min(1),
          reviewersRequired: z.literal(true),
          preventSelfReview: z.literal(true),
          deploymentBranches: z.array(z.string().min(1)).min(1),
          deploymentPolicyType: z.literal('branch'),
        })
        .strict(),
    ),
    rulesets: z.array(
      z
        .object({
          id: z.string().min(1),
          target: z.enum(['branch', 'tag']),
          include: z.array(z.string().min(1)).min(1),
          requiredRuleTypes: z.array(z.string().min(1)),
          pullRequest: z
            .object({
              approvals: z.number().int().positive(),
              codeOwnerReview: z.boolean(),
            })
            .optional(),
          requiredStatusChecks: z.array(z.string().min(1)).default([]),
          forbidBypassActors: z.boolean().default(false),
          adminOnlyBypass: z.boolean().default(false),
        })
        .strict(),
    ),
    manual: z.array(
      z
        .object({
          id: z.string().min(1),
          description: z.string().min(1),
          condition: ManualConditionSchema.optional(),
        })
        .strict(),
    ),
  })
  .strict();

const EnvironmentsResponseSchema = z.array(EnvironmentSchema);
const BranchPoliciesResponseSchema = z.array(BranchPolicySchema);
const RulesetsResponseSchema = z.array(RulesetSchema);

export type SecurityBaseline = z.infer<typeof BaselineSchema>;

export interface GitHubSecurityApi {
  listEnvironments(repository: string): Promise<unknown>;
  listEnvironmentBranchPolicies(repository: string, environmentName: string): Promise<unknown>;
  listRulesets(repository: string): Promise<unknown>;
}

export type GitHubApiCommandRunner = (arguments_: string[]) => string;

export interface SecurityDoctorResult {
  failures: string[];
  manual: string[];
  passes: string[];
}

export class GitHubApiError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly apiMessage: string,
    readonly endpoint: string,
  ) {
    super(apiMessage);
    this.name = 'GitHubApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRepoSlug(value: string): string | undefined {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9_.-]+)$/.exec(value);
  if (!match) return undefined;
  return `${match[1]}/${match[2]}`;
}

function normalizeRepository(value: string): string | undefined {
  const parsed = parseRepoSlug(value.trim());
  return parsed?.toLowerCase();
}

function parseJsonLines(stdout: string): unknown[] {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return lines.map((line) => JSON.parse(line) as unknown);
}

function extractHttpStatus(message: string): number | undefined {
  const match = /\bHTTP\s+(\d{3})\b/i.exec(message);
  return match ? Number(match[1]) : undefined;
}

function safeGitHubErrorMessage(message: string, status: number | undefined): string {
  if (status === 401) {
    return 'GitHub authentication failed (HTTP 401); the required repository protections cannot be verified.';
  }
  if (status === 403 && /upgrade to github pro or make this repository public/i.test(message)) {
    return 'GitHub does not expose repository rulesets for this private repository plan (HTTP 403); upgrade the plan or use a visibility that supports rulesets.';
  }
  if (status === 403) {
    return 'GitHub denied access to a required protection endpoint (HTTP 403); the required repository protections cannot be verified.';
  }
  if (status === 404) {
    return 'GitHub returned HTTP 404 for a required protection endpoint; the required repository protections cannot be verified.';
  }
  return status
    ? `GitHub API request failed (HTTP ${status}); the required repository protections cannot be verified.`
    : 'GitHub API request failed or timed out; the required repository protections cannot be verified.';
}

function runGhApiCommand(arguments_: string[]): string {
  try {
    return execFileSync('gh', arguments_, {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const commandError = isRecord(error) ? error : {};
    const stderr = commandError.stderr;
    const detail = [
      error instanceof Error ? error.message : String(error),
      typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString('utf8') : '',
    ]
      .filter(Boolean)
      .join('\n');
    const status = extractHttpStatus(detail);
    const safeMessage = safeGitHubErrorMessage(detail, status);
    const endpoint = arguments_.at(-1) ?? 'unknown GitHub API endpoint';
    throw new GitHubApiError(status, safeMessage, endpoint);
  }
}

function readPaginatedEndpoint(
  endpoint: string,
  jqFilter: string,
  runCommand: GitHubApiCommandRunner,
): unknown[] {
  const stdout = runCommand([
    'api',
    '--hostname',
    'github.com',
    '--paginate',
    '-H',
    'Accept: application/vnd.github+json',
    '-H',
    'X-GitHub-Api-Version: 2026-03-10',
    '--jq',
    jqFilter,
    endpoint,
  ]);
  return parseJsonLines(stdout);
}

function parseOne<T>(items: unknown[], schema: z.ZodType<T>, label: string): T {
  if (items.length !== 1) throw new Error(`Expected one ${label} response.`);
  return schema.parse(items[0]);
}

export function createGitHubCliSecurityApi(
  runCommand: GitHubApiCommandRunner = runGhApiCommand,
): GitHubSecurityApi {
  return {
    async listEnvironments(repository) {
      const slug = parseRepoSlug(repository);
      if (!slug) throw new Error('Repository must use owner/name format.');
      return readPaginatedEndpoint(
        `repos/${slug}/environments?per_page=100`,
        '.environments[]',
        runCommand,
      );
    },
    async listEnvironmentBranchPolicies(repository, environmentName) {
      const slug = parseRepoSlug(repository);
      if (!slug) throw new Error('Repository must use owner/name format.');
      const environment = encodeURIComponent(environmentName);
      const endpoint = `repos/${slug}/environments/${environment}/deployment-branch-policies?per_page=100`;
      return readPaginatedEndpoint(endpoint, '.branch_policies[]', runCommand);
    },
    async listRulesets(repository) {
      const slug = parseRepoSlug(repository);
      if (!slug) throw new Error('Repository must use owner/name format.');
      const summaries = readPaginatedEndpoint(
        `repos/${slug}/rulesets?per_page=100&includes_parents=true&targets=branch,tag`,
        '.[]',
        runCommand,
      ).map((summary) => RulesetSummarySchema.parse(summary));

      const details: unknown[] = [];
      for (const summary of summaries) {
        const endpoint = `repos/${slug}/rulesets/${summary.id}?includes_parents=true`;
        const response = readPaginatedEndpoint(endpoint, '.', runCommand);
        details.push(parseOne(response, RulesetSchema, `ruleset ${summary.id}`));
      }
      return details;
    },
  };
}

export const githubCliSecurityApi = createGitHubCliSecurityApi();

function readBaseline(baselinePath: string): SecurityBaseline {
  const content = readFileSync(baselinePath, 'utf8');
  return BaselineSchema.parse(JSON.parse(content) as unknown);
}

function recordIssue(result: SecurityDoctorResult, message: string): void {
  result.failures.push(message);
}

function asErrorMessage(error: unknown, label: string): string {
  if (error instanceof GitHubApiError) return `${label}: ${error.message}`;
  return `${label}: response did not match the required GitHub API schema.`;
}

function getRuleParameters(rule: z.infer<typeof RulesetRuleSchema>): Record<string, unknown> {
  return rule.parameters ?? {};
}

function checkEnvironment(
  baseline: SecurityBaseline['environments'][number],
  environment: z.infer<typeof EnvironmentSchema>,
  branchPolicies: z.infer<typeof BranchPoliciesResponseSchema>,
  result: SecurityDoctorResult,
): void {
  const reviewers = environment.protection_rules.find((rule) => rule.type === 'required_reviewers');
  if (!reviewers || !reviewers.reviewers || reviewers.reviewers.length === 0) {
    recordIssue(result, `Environment "${baseline.name}" has no required reviewer.`);
  } else if (baseline.preventSelfReview && reviewers.prevent_self_review !== true) {
    recordIssue(result, `Environment "${baseline.name}" does not prevent self-review.`);
  } else {
    result.passes.push(`Environment "${baseline.name}" requires an independent reviewer.`);
  }

  const branchPolicy = environment.deployment_branch_policy;
  if (!branchPolicy?.custom_branch_policies || branchPolicy.protected_branches) {
    recordIssue(
      result,
      `Environment "${baseline.name}" is not restricted to its declared deployment branches.`,
    );
    return;
  }

  const mismatchedTypes = branchPolicies.filter(
    (policy) => policy.type !== undefined && policy.type !== baseline.deploymentPolicyType,
  );
  if (mismatchedTypes.length > 0) {
    recordIssue(
      result,
      `Environment "${baseline.name}" deployment policy includes a tag policy where a branch policy is required.`,
    );
  }
  if (branchPolicies.some((policy) => policy.type === undefined)) {
    result.manual.push(
      `environment-policy-type:${baseline.name}: GitHub did not return whether its deployment policy targets a branch or tag; verify this Environment in repository settings.`,
    );
  }

  const actualBranches = branchPolicies.map((policy) => policy.name).sort();
  const expectedBranches = [...baseline.deploymentBranches].sort();
  if (
    actualBranches.length !== expectedBranches.length ||
    actualBranches.some((name, index) => name !== expectedBranches[index])
  ) {
    recordIssue(
      result,
      `Environment "${baseline.name}" deployment branches differ from the baseline (expected ${expectedBranches.join(', ') || '(none)'}, found ${actualBranches.join(', ') || '(none)'}).`,
    );
    return;
  }

  if (branchPolicies.every((policy) => policy.type === baseline.deploymentPolicyType)) {
    result.passes.push(
      `Environment "${baseline.name}" is limited to branch ${expectedBranches.join(', ')}.`,
    );
  }
}

function matchesExpectedRef(ruleset: z.infer<typeof RulesetSchema>, include: string): boolean {
  const refNames = ruleset.conditions?.ref_name;
  if (!refNames || !refNames.include.includes(include)) return false;
  return refNames.exclude.length === 0;
}

function checkRuleset(
  baseline: SecurityBaseline['rulesets'][number],
  allRulesets: z.infer<typeof RulesetsResponseSchema>,
  result: SecurityDoctorResult,
): void {
  const failureCountBefore = result.failures.length;
  const applicable = baseline.include.flatMap((include) =>
    allRulesets.filter(
      (ruleset) => ruleset.target === baseline.target && matchesExpectedRef(ruleset, include),
    ),
  );
  const active = applicable.filter((ruleset) => ruleset.enforcement === 'active');

  if (active.length === 0) {
    recordIssue(
      result,
      `No active ${baseline.target} ruleset covers ${baseline.include.join(', ')} (${baseline.id}).`,
    );
    return;
  }

  const rules = active.flatMap((ruleset) => ruleset.rules);
  const ruleTypes = new Set(rules.map((rule) => rule.type));
  const missingRuleTypes = baseline.requiredRuleTypes.filter((type) => !ruleTypes.has(type));
  if (missingRuleTypes.length > 0) {
    recordIssue(
      result,
      `Ruleset "${baseline.id}" is missing required rules: ${missingRuleTypes.join(', ')}.`,
    );
  }

  if (baseline.pullRequest) {
    const pullRequestRule = rules.find((rule) => rule.type === 'pull_request');
    const parameters = pullRequestRule ? getRuleParameters(pullRequestRule) : {};
    const requiredApprovals = parameters.required_approving_review_count;
    if (
      typeof requiredApprovals !== 'number' ||
      requiredApprovals < baseline.pullRequest.approvals
    ) {
      recordIssue(
        result,
        `Ruleset "${baseline.id}" requires at least ${baseline.pullRequest.approvals} approving review(s).`,
      );
    }
    if (baseline.pullRequest.codeOwnerReview && parameters.require_code_owner_review !== true) {
      recordIssue(result, `Ruleset "${baseline.id}" does not require CODEOWNERS review.`);
    }
  }

  if (baseline.requiredStatusChecks.length > 0) {
    const statusRule = rules.find((rule) => rule.type === 'required_status_checks');
    const parameters = statusRule ? getRuleParameters(statusRule) : {};
    const checks = parameters.required_status_checks;
    const contexts = Array.isArray(checks)
      ? checks.flatMap((check) =>
          isRecord(check) && typeof check.context === 'string' ? [check.context] : [],
        )
      : [];
    const missingChecks = baseline.requiredStatusChecks.filter(
      (context) => !contexts.includes(context),
    );
    if (missingChecks.length > 0) {
      recordIssue(
        result,
        `Ruleset "${baseline.id}" does not require CI status check(s): ${missingChecks.join(', ')}.`,
      );
    }
  }

  let actorsVisibilityUnknown = false;
  for (const ruleset of active) {
    if (ruleset.bypass_actors === undefined) {
      actorsVisibilityUnknown = true;
      continue;
    }

    const bypassActors = ruleset.bypass_actors;
    if (baseline.forbidBypassActors && bypassActors.length > 0) {
      recordIssue(
        result,
        `Ruleset "${baseline.id}" allows bypass actors where the baseline forbids them.`,
      );
    }

    if (baseline.adminOnlyBypass) {
      const hasAdminBypass = bypassActors.some(
        (actor) =>
          actor.actor_type === 'RepositoryRole' &&
          actor.actor_id === 5 &&
          actor.bypass_mode === 'always',
      );
      const hasNonAdminBypass = bypassActors.some(
        (actor) =>
          !(
            actor.actor_type === 'RepositoryRole' &&
            actor.actor_id === 5 &&
            actor.bypass_mode === 'always'
          ),
      );
      if (!hasAdminBypass || hasNonAdminBypass) {
        recordIssue(
          result,
          `Ruleset "${baseline.id}" must allow only repository administrators to bypass tag restrictions.`,
        );
      }
    }
  }

  if (actorsVisibilityUnknown && (baseline.forbidBypassActors || baseline.adminOnlyBypass)) {
    result.manual.push(
      `ruleset-bypass-actors:${baseline.id}: GitHub omitted bypass_actors for this read-only token; verify the bypass policy with an authorized ruleset viewer.`,
    );
  }

  if (result.failures.length === failureCountBefore) {
    result.passes.push(
      `Ruleset "${baseline.id}" covers ${baseline.include.join(', ')} with its visible required rules.`,
    );
  }
}

export async function inspectRepositorySecurity(
  repository: string,
  baseline: SecurityBaseline,
  api: GitHubSecurityApi,
): Promise<SecurityDoctorResult> {
  const result: SecurityDoctorResult = { failures: [], manual: [], passes: [] };
  const normalizedRepository = normalizeRepository(repository);
  if (!normalizedRepository) {
    result.failures.push('Repository must use owner/name format with no URL or ref.');
    return result;
  }

  const environmentsResult = await api
    .listEnvironments(normalizedRepository)
    .catch((error: unknown) => {
      recordIssue(result, asErrorMessage(error, 'Cannot inspect required GitHub Environments'));
      return undefined;
    });

  if (environmentsResult !== undefined) {
    const parsedEnvironments = EnvironmentsResponseSchema.safeParse(environmentsResult);
    if (!parsedEnvironments.success) {
      recordIssue(result, 'GitHub Environments response did not match the required API schema.');
    } else {
      for (const expectedEnvironment of baseline.environments) {
        const environment = parsedEnvironments.data.find(
          ({ name }) => name === expectedEnvironment.name,
        );
        if (!environment) {
          recordIssue(
            result,
            `Required GitHub Environment "${expectedEnvironment.name}" is missing.`,
          );
          continue;
        }

        const policyResult = await api
          .listEnvironmentBranchPolicies(normalizedRepository, expectedEnvironment.name)
          .catch((error: unknown) => {
            recordIssue(
              result,
              asErrorMessage(
                error,
                `Cannot inspect deployment branches for Environment "${expectedEnvironment.name}"`,
              ),
            );
            return undefined;
          });

        if (policyResult === undefined) continue;
        const parsedPolicies = BranchPoliciesResponseSchema.safeParse(policyResult);
        if (!parsedPolicies.success) {
          recordIssue(
            result,
            `Deployment branch policies for Environment "${expectedEnvironment.name}" did not match the required API schema.`,
          );
          continue;
        }
        checkEnvironment(expectedEnvironment, environment, parsedPolicies.data, result);
      }
    }
  }

  const rulesetsResult = await api.listRulesets(normalizedRepository).catch((error: unknown) => {
    recordIssue(result, asErrorMessage(error, 'Cannot inspect required repository rulesets'));
    return undefined;
  });

  if (rulesetsResult !== undefined) {
    const parsedRulesets = RulesetsResponseSchema.safeParse(rulesetsResult);
    if (!parsedRulesets.success) {
      recordIssue(
        result,
        'GitHub repository rulesets response did not match the required API schema.',
      );
    } else {
      for (const expectedRuleset of baseline.rulesets) {
        checkRuleset(expectedRuleset, parsedRulesets.data, result);
      }
    }
  }

  const manualConditions = new Set<string>(
    result.manual
      .map((message) => message.split(':', 1)[0])
      .filter(
        (condition) =>
          condition === 'ruleset-bypass-actors' || condition === 'environment-policy-type',
      ),
  );
  result.manual = [
    ...baseline.manual
      .filter(({ condition }) => condition === undefined || manualConditions.has(condition))
      .map(({ id, description }) => `${id}: ${description}`),
  ];
  return result;
}

function printResult(result: SecurityDoctorResult): void {
  for (const message of result.passes) process.stdout.write(`PASS: ${message}\n`);
  for (const message of result.manual) process.stdout.write(`MANUAL: ${message}\n`);
  for (const message of result.failures) process.stderr.write(`FAIL: ${message}\n`);
  process.stdout.write(
    `Security doctor: ${result.passes.length} pass, ${result.manual.length} manual, ${result.failures.length} fail.\n`,
  );
}

export async function runSecurityDoctor(
  options: { repository?: string; baselinePath?: string; api?: GitHubSecurityApi } = {},
): Promise<number> {
  const repositoryValue = options.repository ?? process.env.GITHUB_REPOSITORY;
  if (!repositoryValue) {
    process.stderr.write('FAIL: Set GITHUB_REPOSITORY or pass --repo owner/name.\n');
    return 1;
  }

  const baselinePath =
    options.baselinePath ?? resolve(process.cwd(), '.github/security-baseline.json');
  let baseline: SecurityBaseline;
  try {
    baseline = readBaseline(baselinePath);
  } catch {
    process.stderr.write('FAIL: .github/security-baseline.json is missing or invalid.\n');
    return 1;
  }

  const result = await inspectRepositorySecurity(
    repositoryValue,
    baseline,
    options.api ?? githubCliSecurityApi,
  );
  printResult(result);
  return result.failures.length === 0 ? 0 : 1;
}

function parseArguments(args: string[]): { repository?: string } | undefined {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === '--repo' && args[1]) return { repository: args[1] };
  return undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    process.stderr.write('Usage: pnpm security:doctor [--repo owner/name]\n');
    process.exitCode = 2;
  } else {
    process.exitCode = await runSecurityDoctor(options);
  }
}
