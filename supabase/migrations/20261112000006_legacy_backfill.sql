-- BringMe! Game Pass 6/7: backfill public.subscriptions -> legacy passes, then Pro 200 -> 100.
-- No behaviour change by itself (the game triggers still read subscriptions until 7/7).
-- Re-runnable: each subscription is converted once (game_passes.legacy_subscription_id unique).
-- Stops BEFORE changing anything if the data can't be mapped exactly.
--
-- Mapping (GAME_PASS_DESIGN.md §7.4):
--   trialing/active/suspended with end > now : pass 'granted', ONE segment = the exact [start, end)
--                                               (suspended => profiles.hosting_suspended_at set)
--   trialing/active/expired/suspended ended  : pass 'granted', historical segment, fully consumed
--   canceled / past_due                      : pass 'revoked' (end_reason legacy_<status>), historical
--                                               segment up to min(end, now) (never entitling)
-- The cap snapshot is the plan's player cap NOW (before the Pro change below), so existing
-- holders keep exactly what they had.
-- Rows tagged external_ref 'ledger_projection:<pass>' were written by the compensating
-- revert (supabase/rollback) as a mirror of the ledger; they are never converted again.

do $$
declare
  v_now  timestamptz := now();
  v_bad  text;
  r      record;
  v_pass uuid;
  v_start timestamptz;
  v_end   timestamptz;
  v_lo    timestamptz;
  v_hi    timestamptz;
  v_dur   numeric;
  v_disp  public.pass_disposition;
  v_reason text;
begin
  if to_regprocedure('public.pass_entitlement(uuid)') is null then
    raise exception 'game_pass_precondition: apply 20261112000005 first';
  end if;

  -- Precondition 1: running legacy rows must not start in the future (would be pulled forward by a replan).
  select string_agg(s.id::text, ', ') into v_bad
    from public.subscriptions s
   where s.status in ('trialing', 'active', 'suspended') and s.current_period_start > v_now
     and coalesce(s.external_ref, '') not like 'ledger_projection:%'
     and not exists (select 1 from public.game_passes g where g.legacy_subscription_id = s.id);
  if v_bad is not null then
    raise exception 'game_pass_backfill: subscriptions starting in the future [%]; adjust them first. Nothing was changed.', v_bad;
  end if;

  -- Precondition 2: running legacy rows of one user must not overlap.
  select string_agg(a.id::text || '/' || b.id::text, ', ') into v_bad
    from public.subscriptions a
    join public.subscriptions b on b.user_id = a.user_id and a.id < b.id
   where a.status in ('trialing', 'active', 'suspended') and b.status in ('trialing', 'active', 'suspended')
     and a.current_period_end > v_now and b.current_period_end > v_now
     and coalesce(a.external_ref, '') not like 'ledger_projection:%' and coalesce(b.external_ref, '') not like 'ledger_projection:%'
     and tstzrange(a.current_period_start, a.current_period_end, '[)') && tstzrange(b.current_period_start, b.current_period_end, '[)');
  if v_bad is not null then
    raise exception 'game_pass_backfill: overlapping running subscriptions [%]; end one of them first. Nothing was changed.', v_bad;
  end if;

  perform set_config('bringme.ledger_maintenance', 'on', true);   -- historical rows (transaction-local)

  for r in
    select s.id, s.user_id, s.plan_id, s.status::text as status, s.current_period_start, s.current_period_end, s.created_at,
           p.max_players_per_game as cap,
           (s.status in ('trialing', 'active', 'suspended') and s.current_period_end > v_now) as running
      from public.subscriptions s
      join public.subscription_plans p on p.id = s.plan_id
     where not exists (select 1 from public.game_passes g where g.legacy_subscription_id = s.id)
       and coalesce(s.external_ref, '') not like 'ledger_projection:%'
     order by 9 desc, s.user_id, s.current_period_start, s.id      -- running rows first, then history
  loop
    if r.running then
      v_start := r.current_period_start;
      v_end   := r.current_period_end;
      if exists (select 1 from public.pass_segments x where x.user_id = r.user_id
                  and tstzrange(x.starts_at, x.ends_at, '[)') && tstzrange(v_start, v_end, '[)')) then
        raise exception 'game_pass_backfill: subscription % overlaps an existing pass of the same user. Nothing was changed.', r.id;
      end if;
      v_disp := 'granted'; v_reason := null;
    else
      v_start := r.current_period_start;
      v_end   := least(r.current_period_end, v_now);
      -- History is informational: clip it around anything already placed so it never overlaps.
      select max(x.ends_at) into v_lo from public.pass_segments x
       where x.user_id = r.user_id and x.starts_at <= v_start and x.ends_at > v_start;
      if v_lo is not null then v_start := v_lo; end if;
      select min(x.starts_at) into v_hi from public.pass_segments x
       where x.user_id = r.user_id and x.starts_at > v_start and x.starts_at < v_end;
      if v_hi is not null then v_end := v_hi; end if;
      if r.status in ('canceled', 'past_due') then
        v_disp := 'revoked'; v_reason := 'legacy_' || r.status;
      elsif v_end <= v_start then
        v_disp := 'revoked'; v_reason := 'legacy_no_unique_time';
      else
        v_disp := 'granted'; v_reason := null;
      end if;
    end if;
    v_dur := greatest(extract(epoch from (v_end - v_start)), 0);

    insert into public.game_passes (user_id, plan_id, source, legacy_subscription_id, max_players, duration_seconds,
                                    disposition, ended_at, end_reason, created_at)
    values (r.user_id, r.plan_id, 'legacy_subscription', r.id, r.cap, v_dur,
            v_disp, case when v_disp <> 'granted' then v_now end, v_reason, r.created_at)
    returning id into v_pass;
    if v_end > v_start then
      insert into public.pass_segments (pass_id, user_id, starts_at, ends_at) values (v_pass, r.user_id, v_start, v_end);
    end if;
    if r.running and r.status = 'suspended' then
      update public.profiles set hosting_suspended_at = coalesce(hosting_suspended_at, v_now) where id = r.user_id;
    end if;
    perform public.log_entitlement_event(r.user_id, v_pass, null, 'migration', null, 'legacy_backfill',
      jsonb_build_object('subscription_id', r.id, 'status', r.status, 'start', r.current_period_start,
                         'end', r.current_period_end, 'running', r.running, 'max_players', r.cap));
  end loop;
end $$;

-- Final catalogue: Pro is 100 players. Only the audited seed value (200) is changed;
-- any other admin-set value is left alone and reported.
update public.subscription_plans set max_players_per_game = 100 where code = 'pro' and max_players_per_game = 200;

do $$
declare
  r record;
begin
  for r in
    select v.code, v.players, p.max_players_per_game as actual
    from (values ('trial', 3), ('starter', 10), ('party', 50), ('pro', 100)) v(code, players)
    left join public.subscription_plans p on p.code = v.code
    where p.max_players_per_game is distinct from v.players
  loop
    raise notice 'game_pass: plan % has % players (expected %); left unchanged, review in Admin > Plans', r.code, r.actual, r.players;
  end loop;
end $$;
