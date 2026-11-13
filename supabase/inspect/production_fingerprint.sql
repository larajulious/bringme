-- BringMe! schema fingerprint (READ-ONLY: catalog SELECTs and row COUNTS only; no personal data).
-- Used by BRINGME_PRODUCTION_MIGRATION_RECONCILIATION.md to compare the hosted database with the
-- schema the repository's migrations produce. Run against the hosted project with:
--   npx supabase db query --remote --read-only -f supabase/inspect/production_fingerprint.sql --output-format json
-- Returns ONE row with one jsonb column `fp`.
with
fn as (
  select jsonb_agg(jsonb_build_object(
    'sig', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
    'result', pg_get_function_result(p.oid),
    'lang', l.lanname,
    'secdef', p.prosecdef,
    'volatile', p.provolatile,
    'config', coalesce(array_to_string(p.proconfig, ','), ''),
    'body_md5', md5(p.prosrc),
    'body_norm_md5', md5(btrim(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', ' ', 'g'))),
    'acl', coalesce((select string_agg(case when a.grantee = 0 then 'PUBLIC' else r.rolname end || ':' || a.privilege_type, ',' order by 1)
                     from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                     left join pg_roles r on r.oid = a.grantee
                     where a.grantee = 0 or r.rolname in ('anon', 'authenticated', 'service_role')), '')
  ) order by p.proname, pg_get_function_identity_arguments(p.oid)) j
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
  where n.nspname = 'public' and p.prokind = 'f'
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')   -- skip extension members
),
tbl as (
  select jsonb_agg(jsonb_build_object('t', c.relname, 'kind', c.relkind, 'rls', c.relrowsecurity, 'force_rls', c.relforcerowsecurity,
    'acl', coalesce((select string_agg(case when a.grantee = 0 then 'PUBLIC' else r.rolname end || ':' || a.privilege_type, ',' order by 1)
                     from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
                     left join pg_roles r on r.oid = a.grantee
                     where a.grantee = 0 or r.rolname in ('anon', 'authenticated', 'service_role')), '')
  ) order by c.relname) j
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
    and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
),
col as (
  select jsonb_agg(jsonb_build_object('c', c.relname || '.' || a.attname, 'type', format_type(a.atttypid, a.atttypmod),
    'notnull', a.attnotnull, 'default', coalesce(pg_get_expr(d.adbin, d.adrelid), ''), 'generated', a.attgenerated::text, 'identity', a.attidentity::text
  ) order by c.relname, a.attnum) j
  from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = 'public' and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
),
colgrant as (   -- column-level grants from the catalog (information_schema hides grants not involving the current role)
  select jsonb_agg(x order by x) j from (
    select distinct c.relname || '.' || at.attname || ':' || r.rolname || ':' || x.privilege_type x
    from pg_attribute at join pg_class c on c.oid = at.attrelid join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(at.attacl) x join pg_roles r on r.oid = x.grantee
    where n.nspname = 'public' and at.attacl is not null and r.rolname in ('anon', 'authenticated')
  ) s
),
con as (
  select jsonb_agg(jsonb_build_object('k', c.conrelid::regclass::text || '/' || c.conname, 'type', c.contype, 'def', pg_get_constraintdef(c.oid)) order by c.conrelid::regclass::text, c.conname) j
  from pg_constraint c join pg_namespace n on n.oid = c.connamespace
  where n.nspname = 'public' and c.conrelid <> 0
),
idx as (
  select jsonb_agg(jsonb_build_object('k', tablename || '/' || indexname, 'def', indexdef) order by tablename, indexname) j
  from pg_indexes where schemaname = 'public'
),
pol as (
  select jsonb_agg(jsonb_build_object('k', schemaname || '.' || tablename || '/' || policyname, 'permissive', permissive,
    'roles', array_to_string(roles, ','), 'cmd', cmd, 'qual', coalesce(qual, ''), 'check', coalesce(with_check, '')
  ) order by schemaname, tablename, policyname) j
  from pg_policies
  where schemaname = 'public' or (schemaname = 'storage' and tablename = 'objects') or (schemaname = 'realtime' and tablename = 'messages')
),
trg as (
  select jsonb_agg(jsonb_build_object('k', n.nspname || '.' || c.relname || '/' || t.tgname, 'def', pg_get_triggerdef(t.oid), 'enabled', t.tgenabled::text) order by n.nspname, c.relname, t.tgname) j
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal and (n.nspname = 'public' or (n.nspname = 'auth' and c.relname = 'users'))
),
enums as (
  select jsonb_agg(jsonb_build_object('t', t.typname, 'labels', (select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid)) order by t.typname) j
  from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typtype = 'e'
),
ext as (
  select jsonb_agg(jsonb_build_object('name', e.extname, 'schema', n.nspname) order by e.extname) j
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname in ('btree_gist', 'pgcrypto', 'pg_stat_statements')
),
facts as (
  select jsonb_build_object(
    'migration_history_table', to_regclass('supabase_migrations.schema_migrations') is not null,
    'plans', (select jsonb_agg(jsonb_build_object('code', code, 'tier', tier, 'is_trial', is_trial, 'is_active', is_active,
                'max_players_per_game', max_players_per_game, 'duration_seconds', duration_seconds) order by code) from public.subscription_plans),
    'plan_prices', (select jsonb_agg(x order by x) from (select currency || ':' || is_active || ':' || count(*) x from public.plan_prices group by currency, is_active) s),
    'disposable_domains', (select count(*) from public.disposable_email_domains),
    'disposable_allowlist', (select count(*) from public.disposable_email_allowlist),
    'disposable_versions', (select jsonb_agg(jsonb_build_object('source_ref', source_ref, 'domain_count', domain_count, 'active', is_active) order by id) from public.disposable_email_list_versions),
    'platform_settings_rows', (select count(*) from public.platform_settings),
    'snappy_counter_rows', (select count(*) from public.snappy_counter),
    'legacy_snappy_tables', (to_regclass('public.snappy_tap_shards') is not null) or (to_regclass('public.snappy_tap_limits') is not null),
    'bucket', (select jsonb_build_object('public', public, 'file_size_limit', file_size_limit, 'mime', array_to_string(allowed_mime_types, ',')) from storage.buckets where id = 'submissions'),
    'subscriptions', (select count(*) from public.subscriptions),
    'subscriptions_without_legacy_pass', (select count(*) from public.subscriptions s where not exists (select 1 from public.game_passes g where g.legacy_subscription_id = s.id)),
    'passes_by_source', (select jsonb_object_agg(source, n) from (select source::text, count(*) n from public.game_passes group by source) s),
    'games_by_status', (select jsonb_object_agg(status, n) from (select status::text, count(*) n from public.games group by status) s),
    'games_phase_mismatch', (select count(*) from public.games where status in ('finished', 'canceled') and phase <> 'finished'),
    'games_by_type', (select jsonb_object_agg(game_type, n) from (select game_type::text, count(*) n from public.games group by game_type) s)
  ) j
)
select jsonb_build_object(
  'functions', (select j from fn), 'tables', (select j from tbl), 'columns', (select j from col), 'column_grants', (select j from colgrant),
  'constraints', (select j from con), 'indexes', (select j from idx), 'policies', (select j from pol), 'triggers', (select j from trg),
  'enums', (select j from enums), 'extensions', (select j from ext), 'facts', (select j from facts)
) as fp;
