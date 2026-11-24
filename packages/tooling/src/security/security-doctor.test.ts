import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  createGitHubCliSecurityApi,
  GitHubApiError,
  inspectRepositorySecurity,
  type GitHubSecurityApi,
  type SecurityBaseline,
} from './security-doctor.js';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(testDirectory, 'fixtures/github-api');
const repositoryRoot = resolve(testDirectory, '../../../../');

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(fixtureDirectory, name), 'utf8')) as T;
}

const baseline = JSON.parse(
  readFileSync(resolve(repositoryRoot, '.github/security-baseline.json'), 'utf8'),
) as SecurityBaseline;

function fixtureApi(overrides: Partial<GitHubSecurityApi> = {}): GitHubSecurityApi {
  const environments = fixture<unknown[]>('environments.complete.json');
  const policies = fixture<Record<string, unknown[]>>('branch-policies.documented.json');
  const rulesets = [
    fixture<unknown>('ruleset.main.read-only.json'),
    fixture<unknown>('ruleset.mobile-tags.read-only.json'),
    fixture<unknown>('ruleset.source-tags.read-only.json'),
  ];

  return {
    listEnvironments: async () => environments,
    listEnvironmentBranchPolicies: async (_repository, environmentName) =>
      policies[environmentName] ?? [],
    listRulesets: async () => rulesets,
    ...overrides,
  };
}

function writableRulesetFixtures(): Array<Record<string, unknown>> {
  const rulesets = [
    fixture<Record<string, unknown>>('ruleset.main.read-only.json'),
    fixture<Record<string, unknown>>('ruleset.mobile-tags.read-only.json'),
    fixture<Record<string, unknown>>('ruleset.source-tags.read-only.json'),
  ];

  for (const ruleset of rulesets) {
    ruleset.bypass_actors =
      ruleset.target === 'branch'
        ? []
        : [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }];
  }

  return rulesets;
}

function writableApi(rulesets = writableRulesetFixtures()): GitHubSecurityApi {
  const environments = fixture<unknown[]>('environments.complete.json').map((environment) => {
    const parsed = environment as { name: string };
    const rows = fixture<Record<string, Array<Record<string, unknown>>>>(
      'branch-policies.documented.json',
    );
    const policies = rows[parsed.name] ?? [];
    return { environment, policies };
  });

  return {
    listEnvironments: async () =>
      environments.map(({ environment }) => {
        const record = environment as Record<string, unknown>;
        return {
          ...record,
          deployment_branch_policy: {
            protected_branches: false,
            custom_branch_policies: true,
          },
        };
      }),
    listEnvironmentBranchPolicies: async (_repository, environmentName) =>
      (
        environments.find(
          ({ environment }) => (environment as { name: string }).name === environmentName,
        )?.policies ?? []
      ).map((policy) => ({ ...policy, type: 'branch' })),
    listRulesets: async () => rulesets,
  };
}

describe('inspectRepositorySecurity', () => {
  it('reports checks hidden from read-only API responses as manual, never as verified', async () => {
    const result = await inspectRepositorySecurity('Example/Base-App', baseline, fixtureApi());

    expect(result.failures).toEqual([]);
    expect(
      result.manual.some((message) => message.startsWith('deployment-branch-policy-type:')),
    ).toBe(true);
    expect(result.manual.some((message) => message.startsWith('ruleset-bypass-actors:'))).toBe(
      true,
    );
    expect(result.passes.some((message) => message.includes('administrator'))).toBe(false);
  });

  it('fails when a required Environment is missing', async () => {
    const api = fixtureApi({ listEnvironments: async () => [] });
    const result = await inspectRepositorySecurity('example/base-app', baseline, api);

    expect(result.failures).toContain('Required GitHub Environment "production" is missing.');
    expect(result.failures).toContain('Required GitHub Environment "release" is missing.');
  });

  it('fails when a required Environment has no reviewer', async () => {
    const environments = fixture<unknown[]>('environments.complete.json').map((environment) => {
      const record = environment as { name: string; protection_rules: unknown[] };
      return record.name === 'production' ? { ...record, protection_rules: [] } : record;
    });
    const result = await inspectRepositorySecurity(
      'example/base-app',
      baseline,
      fixtureApi({ listEnvironments: async () => environments }),
    );

    expect(result.failures).toContain('Environment "production" has no required reviewer.');
  });

  it('fails when a reviewer can approve their own deployment', async () => {
    const environments = fixture<unknown[]>('environments.complete.json').map((environment) => {
      const record = environment as {
        name: string;
        protection_rules: Array<Record<string, unknown>>;
      };
      return record.name === 'production'
        ? {
            ...record,
            protection_rules: record.protection_rules.map((rule) => ({
              ...rule,
              prevent_self_review: false,
            })),
          }
        : record;
    });
    const result = await inspectRepositorySecurity(
      'example/base-app',
      baseline,
      fixtureApi({ listEnvironments: async () => environments }),
    );

    expect(result.failures).toContain('Environment "production" does not prevent self-review.');
  });

  it('fails if a deployment policy targets a tag named main', async () => {
    const result = await inspectRepositorySecurity(
      'example/base-app',
      baseline,
      fixtureApi({
        listEnvironmentBranchPolicies: async (_repository, environmentName) =>
          environmentName === 'production'
            ? [{ id: 1, name: 'main', type: 'tag' }]
            : [{ id: 2, name: 'main', type: 'branch' }],
      }),
    );

    expect(result.failures).toContain(
      'Environment "production" deployment policy includes a tag policy where a branch policy is required.',
    );
  });

  it('fails when the main ruleset is absent', async () => {
    const tagsOnly = [
      fixture<unknown>('ruleset.mobile-tags.read-only.json'),
      fixture<unknown>('ruleset.source-tags.read-only.json'),
    ];
    const result = await inspectRepositorySecurity(
      'example/base-app',
      baseline,
      fixtureApi({ listRulesets: async () => tagsOnly }),
    );

    expect(result.failures).toContain('No active branch ruleset covers refs/heads/main (main).');
  });

  it('fails when a main ruleset excludes main through a wildcard', async () => {
    const main = fixture<Record<string, unknown>>('ruleset.main.read-only.json');
    const conditions = main.conditions as Record<string, unknown>;
    const refName = conditions.ref_name as Record<string, unknown>;
    refName.exclude = ['refs/heads/*'];
    const result = await inspectRepositorySecurity(
      'example/base-app',
      baseline,
      fixtureApi({
        listRulesets: async () => [
          main,
          fixture<unknown>('ruleset.mobile-tags.read-only.json'),
          fixture<unknown>('ruleset.source-tags.read-only.json'),
        ],
      }),
    );

    expect(result.failures).toContain('No active branch ruleset covers refs/heads/main (main).');
  });

  it('fails when a release-tag ruleset excludes a subset of the required pattern', async () => {
    const sourceTags = fixture<Record<string, unknown>>('ruleset.source-tags.read-only.json');
    const conditions = sourceTags.conditions as Record<string, unknown>;
    const refName = conditions.ref_name as Record<string, unknown>;
    refName.exclude = ['refs/tags/v1.0'];
    const result = await inspectRepositorySecurity(
      'example/base-app',
      baseline,
      fixtureApi({
        listRulesets: async () => [
          fixture<unknown>('ruleset.main.read-only.json'),
          fixture<unknown>('ruleset.mobile-tags.read-only.json'),
          sourceTags,
        ],
      }),
    );

    expect(result.failures).toContain(
      'No active tag ruleset covers refs/tags/v* (source-release-tags).',
    );
  });

  it('fails when enforcement is evaluate', async () => {
    const main = fixture<Record<string, unknown>>('ruleset.main.read-only.json');
    main.enforcement = 'evaluate';
    const result = await inspectRepositorySecurity(
      'example/base-app',
      baseline,
      fixtureApi({
        listRulesets: async () => [
          main,
          fixture<unknown>('ruleset.mobile-tags.read-only.json'),
          fixture<unknown>('ruleset.source-tags.read-only.json'),
        ],
      }),
    );

    expect(result.failures).toContain('No active branch ruleset covers refs/heads/main (main).');
  });

  it('rejects unknown enforcement strings instead of treating them as active', async () => {
    const main = fixture<Record<string, unknown>>('ruleset.main.read-only.json');
    main.enforcement = 'enabled';
    const result = await inspectRepositorySecurity(
      'example/base-app',
      baseline,
      fixtureApi({
        listRulesets: async () => [
          main,
          fixture<unknown>('ruleset.mobile-tags.read-only.json'),
          fixture<unknown>('ruleset.source-tags.read-only.json'),
        ],
      }),
    );

    expect(result.failures).toContain(
      'GitHub repository rulesets response did not match the required API schema.',
    );
  });

  it('fails when either required release-tag ruleset is absent', async () => {
    const noMobileTagRule = [
      fixture<unknown>('ruleset.main.read-only.json'),
      fixture<unknown>('ruleset.source-tags.read-only.json'),
    ];
    const result = await inspectRepositorySecurity(
      'example/base-app',
      baseline,
      fixtureApi({ listRulesets: async () => noMobileTagRule }),
    );

    expect(result.failures).toContain(
      'No active tag ruleset covers refs/tags/mobile-v* (mobile-release-tags).',
    );
  });

  it('fails if the main ruleset does not require the CI status check', async () => {
    const main = fixture<Record<string, unknown>>('ruleset.main.read-only.json');
    const rules = main.rules as Array<Record<string, unknown>>;
    main.rules = rules.map((rule) =>
      rule.type === 'required_status_checks'
        ? { ...rule, parameters: { required_status_checks: [{ context: 'lint' }] } }
        : rule,
    );
    const api = fixtureApi({
      listRulesets: async () => [
        main,
        fixture<unknown>('ruleset.mobile-tags.read-only.json'),
        fixture<unknown>('ruleset.source-tags.read-only.json'),
      ],
    });
    const result = await inspectRepositorySecurity('example/base-app', baseline, api);

    expect(result.failures).toContain(
      'Ruleset "main" does not require CI status check(s): CI / verify.',
    );
  });

  it('enforces bypass restrictions when the API includes bypass_actors', async () => {
    const result = await inspectRepositorySecurity('example/base-app', baseline, writableApi());

    expect(result.failures).toEqual([]);
    expect(result.manual.some((message) => message.includes('ruleset-bypass-actors:'))).toBe(false);
    expect(
      result.manual.some((message) => message.includes('deployment-branch-policy-type:')),
    ).toBe(false);
  });

  it('rejects a non-administrator bypass actor for release tags', async () => {
    const rulesets = writableRulesetFixtures();
    const mobileTags = rulesets.find((ruleset) => ruleset.id === 12);
    expect(mobileTags).toBeDefined();
    if (!mobileTags) throw new Error('Mobile tag fixture is missing.');
    mobileTags.bypass_actors = [
      { actor_id: 4, actor_type: 'RepositoryRole', bypass_mode: 'always' },
    ];
    const redactedDuplicate = {
      ...fixture<Record<string, unknown>>('ruleset.mobile-tags.read-only.json'),
      id: 14,
      name: 'mobile-release-tags-redacted',
    };
    const result = await inspectRepositorySecurity(
      'example/base-app',
      baseline,
      fixtureApi({ listRulesets: async () => [...rulesets, redactedDuplicate] }),
    );

    expect(result.failures).toContain(
      'Ruleset "mobile-release-tags" must allow only repository administrators to bypass tag restrictions.',
    );
    expect(result.manual.some((message) => message.startsWith('ruleset-bypass-actors:'))).toBe(
      true,
    );
  });

  it('rejects any bypass actor for the main ruleset when that field is visible', async () => {
    const rulesets = writableRulesetFixtures();
    const main = rulesets.find((ruleset) => ruleset.id === 11);
    expect(main).toBeDefined();
    if (!main) throw new Error('Main ruleset fixture is missing.');
    main.bypass_actors = [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }];
    const result = await inspectRepositorySecurity(
      'example/base-app',
      baseline,
      writableApi(rulesets),
    );

    expect(result.failures).toContain(
      'Ruleset "main" allows bypass actors where the baseline forbids them.',
    );
  });

  it('fails closed for authentication errors and ruleset-plan restrictions', async () => {
    const authApi = fixtureApi({
      listEnvironments: async () => {
        throw new GitHubApiError(401, 'GitHub authentication failed (HTTP 401).', 'environments');
      },
    });
    const authResult = await inspectRepositorySecurity('example/base-app', baseline, authApi);
    expect(authResult.failures).toContain(
      'Cannot inspect required GitHub Environments: GitHub authentication failed (HTTP 401).',
    );

    const planApi = fixtureApi({
      listRulesets: async () => {
        throw new GitHubApiError(
          403,
          'GitHub does not expose repository rulesets for this private repository plan (HTTP 403); upgrade the plan or use a visibility that supports rulesets.',
          'rulesets',
        );
      },
    });
    const planResult = await inspectRepositorySecurity('example/base-app', baseline, planApi);
    expect(
      planResult.failures.some((message) =>
        message.includes(
          'Cannot inspect required repository rulesets: GitHub does not expose repository rulesets',
        ),
      ),
    ).toBe(true);
  });
});

describe('createGitHubCliSecurityApi', () => {
  it('expands paginated ruleset summaries into detail records', async () => {
    const summaries = fixture<unknown[]>('rulesets.summaries.json');
    const details: Record<string, unknown> = {
      '11': fixture('ruleset.main.read-only.json'),
      '12': fixture('ruleset.mobile-tags.read-only.json'),
      '13': fixture('ruleset.source-tags.read-only.json'),
    };
    const commands: string[][] = [];
    const runCommand = vi.fn((arguments_: string[]) => {
      commands.push(arguments_);
      const endpoint = arguments_.at(-1) ?? '';
      if (endpoint.includes('/rulesets?'))
        return summaries.map((item) => JSON.stringify(item)).join('\n');
      const detailMatch = /\/rulesets\/(\d+)\?/.exec(endpoint);
      const id = detailMatch?.[1];
      return id ? JSON.stringify(details[id] ?? {}) : '';
    });
    const api = createGitHubCliSecurityApi(runCommand);

    const actual = await api.listRulesets('Example/Base-App');

    expect(Array.isArray(actual)).toBe(true);
    if (!Array.isArray(actual)) throw new Error('Ruleset API did not return an array.');
    expect(actual).toHaveLength(3);
    expect(commands[0]?.includes('--paginate')).toBe(true);
    expect(commands.filter((command) => command.at(-1)?.includes('/rulesets/'))).toHaveLength(3);
    expect(
      commands
        .filter((command) => command.at(-1)?.includes('/rulesets/'))
        .every((command) => command.includes('--paginate')),
    ).toBe(true);
    expect(actual[0]).toMatchObject({
      rules: expect.arrayContaining([
        expect.objectContaining({
          type: 'pull_request',
          parameters: expect.objectContaining({
            required_approving_review_count: 1,
            require_code_owner_review: true,
          }),
        }),
      ]),
    });
  });

  it('uses paginated API filters for environment and branch-policy lists', async () => {
    const commands: string[][] = [];
    const runCommand = vi.fn((arguments_: string[]) => {
      commands.push(arguments_);
      return '';
    });
    const api = createGitHubCliSecurityApi(runCommand);

    await api.listEnvironments('Example/Base-App');
    await api.listEnvironmentBranchPolicies('Example/Base-App', 'production/config');

    expect(commands[0]?.includes('--paginate')).toBe(true);
    expect(commands[0]?.includes('.environments[]')).toBe(true);
    expect(commands[1]?.includes('--paginate')).toBe(true);
    expect(commands[1]?.includes('.branch_policies[]')).toBe(true);
    expect(commands[1]?.at(-1)).toContain('production%2Fconfig');
  });
});
