import { describe, expect, it } from 'vitest';
import { lintAuditWrites } from './audit-writes.js';

const insert = "insert into audit.events (action) values ('test.event');";
const routine = (
  name = 'ops.purge_expired',
  security = 'security definer',
  searchPath = "''",
  args = '',
) =>
  `create or replace function ${name}(${args}) returns void language plpgsql ${security} set search_path = ${searchPath} as $$ begin ${insert} end; $$;`;

describe('core SQL audit write boundaries', () => {
  it('allows the two signatures already required by the specifications', async () => {
    expect(await lintAuditWrites(routine())).toEqual([]);
    expect(
      await lintAuditWrites(
        routine(
          'app_config.set_setting',
          'security definer',
          "''",
          'p_key text, p_value jsonb, p_actor_type text, p_actor_ref text, p_correlation_id text, p_expected_updated_at timestamptz',
        ),
      ),
    ).toEqual([]);
  });
  it.each([
    insert,
    `with changed as (insert into audit.events (action) values ('test.event') returning *) select * from changed;`,
    routine('ops.unapproved'),
    routine('ops.purge_expired', 'security invoker'),
    routine('ops.purge_expired', 'security definer', 'public'),
    routine('ops.purge_expired', 'security definer', "''", 'unexpected text'),
    `${routine()}\n${insert}`,
    `/* create function ops.purge_expired() returns void language plpgsql security definer set search_path = '' as $$ */\n${insert}\n/* $$; */`,
  ])('rejects writes outside the approved function boundary: %s', async (source) => {
    expect(await lintAuditWrites(source)).not.toEqual([]);
  });
  it('fails closed on invalid SQL', async () => {
    expect(await lintAuditWrites('create function broken')).not.toEqual([]);
  });
});
