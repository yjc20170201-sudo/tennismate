-- 테니스메이트 B2 · 004_split_elo.sql
-- 단식/복식 ELO 분리 (사용자 결정 2026-09-01: "랭킹 분리해야돼")
-- 선행: 001~003
--
-- 설계
--  * 통장 3개: elo_pts(통합·기존 그대로) + singles_pts + doubles_pts (각 1000 시작)
--  * confirm_match()가 통합 델타와 해당 종목 델타를 각각 계산해 둘 다 반영
--  * elo_history 원장에 kind / kind_delta / kind_pts_after 컬럼 추가 (append-only 유지)
--  * 랭킹 뷰: rankings(통합·기존) + rankings_singles + rankings_doubles (해당 종목 1경기 이상)
--  * 기존 002 RPC 시그니처는 변경 없음 — 클라이언트 호환 유지

-- ─────────────────────────────────────────────
-- 1. 컬럼 추가
-- ─────────────────────────────────────────────
alter table public.profiles
  add column singles_pts     integer not null default 1000,
  add column doubles_pts     integer not null default 1000,
  add column singles_matches integer not null default 0,
  add column singles_wins    integer not null default 0,
  add column doubles_matches integer not null default 0,
  add column doubles_wins    integer not null default 0;

alter table public.elo_history
  add column kind           public.match_kind,
  add column kind_delta     integer,
  add column kind_pts_after integer;

-- ─────────────────────────────────────────────
-- 2. 가드 트리거 확장 — 새 컬럼도 클라이언트가 못 바꾸게
-- ─────────────────────────────────────────────
create or replace function public.guard_profile_columns()
returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.role            := old.role;
    new.elo_pts         := old.elo_pts;
    new.matches         := old.matches;
    new.wins            := old.wins;
    new.manner_avg      := old.manner_avg;
    new.deleted_at      := old.deleted_at;
    new.singles_pts     := old.singles_pts;
    new.doubles_pts     := old.doubles_pts;
    new.singles_matches := old.singles_matches;
    new.singles_wins    := old.singles_wins;
    new.doubles_matches := old.doubles_matches;
    new.doubles_wins    := old.doubles_wins;
  end if;
  return new;
end $$;

-- ─────────────────────────────────────────────
-- 3. 팀 델타 헬퍼 (K=32, 400 스케일, 승자 최소 +1 / 패자 최대 -1)
--    team1 관점의 델타를 돌려준다.
-- ─────────────────────────────────────────────
create or replace function public.elo_team_delta(r1 numeric, r2 numeric, team1_won boolean)
returns integer language sql immutable as $$
  select case when team1_won
    then greatest(1, round(32 * (1 - 1 / (1 + power(10::numeric, (r2 - r1) / 400)))))::integer
    else least(-1, round(32 * (0 - 1 / (1 + power(10::numeric, (r2 - r1) / 400)))))::integer
  end;
$$;

-- ─────────────────────────────────────────────
-- 4. confirm_match() v2 — 통합 + 종목별 반영
-- ─────────────────────────────────────────────
create or replace function public.confirm_match(p_match_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me            uuid := auth.uid();
  v_match         public.matches%rowtype;
  v_my_team       smallint;
  v_reporter_team smallint;
  v_r1            numeric;  -- 통합: team1 평균
  v_r2            numeric;
  v_k1            numeric;  -- 종목: team1 평균
  v_k2            numeric;
  v_delta1        integer;  -- 통합 team1 델타
  v_kdelta1       integer;  -- 종목 team1 델타
  v_rec           record;
  v_delta         integer;
  v_after         integer;
  v_kdelta        integer;
  v_kafter        integer;
begin
  if v_me is null then
    raise exception '로그인이 필요합니다' using errcode = '28000';
  end if;

  select * into v_match from public.matches where id = p_match_id for update;
  if not found then
    raise exception '경기를 찾을 수 없습니다';
  end if;
  if v_match.status <> 'pending' then
    raise exception '이미 처리된 경기입니다 (상태: %)', v_match.status;
  end if;

  select team into v_my_team
  from public.match_players where match_id = p_match_id and player_id = v_me;
  if v_my_team is null then
    raise exception '이 경기의 참가자만 승인할 수 있습니다' using errcode = '42501';
  end if;

  select team into v_reporter_team
  from public.match_players where match_id = p_match_id and player_id = v_match.reporter_id;
  if v_my_team = v_reporter_team then
    raise exception '결과 승인은 상대편 선수만 할 수 있습니다' using errcode = '42501';
  end if;

  -- 통합 풀 + 해당 종목 풀의 팀 평균 레이팅
  select avg(p.elo_pts) filter (where mp.team = 1),
         avg(p.elo_pts) filter (where mp.team = 2),
         avg(case when v_match.kind = 'singles' then p.singles_pts else p.doubles_pts end) filter (where mp.team = 1),
         avg(case when v_match.kind = 'singles' then p.singles_pts else p.doubles_pts end) filter (where mp.team = 2)
    into v_r1, v_r2, v_k1, v_k2
  from public.match_players mp
  join public.profiles p on p.id = mp.player_id
  where mp.match_id = p_match_id;

  v_delta1  := public.elo_team_delta(v_r1, v_r2, v_match.winner_team = 1);
  v_kdelta1 := public.elo_team_delta(v_k1, v_k2, v_match.winner_team = 1);

  for v_rec in
    select mp.player_id, mp.team, p.elo_pts, p.singles_pts, p.doubles_pts
    from public.match_players mp
    join public.profiles p on p.id = mp.player_id
    where mp.match_id = p_match_id
    order by mp.team, mp.player_id
    for update of p
  loop
    v_delta  := case when v_rec.team = 1 then v_delta1  else -v_delta1  end;
    v_after  := greatest(0, v_rec.elo_pts + v_delta);
    v_kdelta := case when v_rec.team = 1 then v_kdelta1 else -v_kdelta1 end;
    v_kafter := greatest(0, (case when v_match.kind = 'singles' then v_rec.singles_pts else v_rec.doubles_pts end) + v_kdelta);

    insert into public.elo_history (player_id, match_id, delta, pts_after, kind, kind_delta, kind_pts_after)
    values (v_rec.player_id, p_match_id, v_delta, v_after, v_match.kind, v_kdelta, v_kafter);

    update public.profiles
       set elo_pts = v_after,
           matches = matches + 1,
           wins    = wins + (case when v_rec.team = v_match.winner_team then 1 else 0 end),
           singles_pts     = case when v_match.kind = 'singles' then v_kafter else singles_pts end,
           singles_matches = singles_matches + (case when v_match.kind = 'singles' then 1 else 0 end),
           singles_wins    = singles_wins + (case when v_match.kind = 'singles' and v_rec.team = v_match.winner_team then 1 else 0 end),
           doubles_pts     = case when v_match.kind = 'doubles' then v_kafter else doubles_pts end,
           doubles_matches = doubles_matches + (case when v_match.kind = 'doubles' then 1 else 0 end),
           doubles_wins    = doubles_wins + (case when v_match.kind = 'doubles' and v_rec.team = v_match.winner_team then 1 else 0 end)
     where id = v_rec.player_id;
  end loop;

  update public.matches
     set status = 'confirmed', confirmed_by = v_me, confirmed_at = now()
   where id = p_match_id;
end $$;

-- ─────────────────────────────────────────────
-- 5. rebuild_profile_stats() v2 — 종목 풀 포함 재구축
-- ─────────────────────────────────────────────
create or replace function public.rebuild_profile_stats()
returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.profiles p
     set elo_pts = coalesce(h.last_pts, 1000),
         matches = coalesce(s.cnt, 0),
         wins    = coalesce(s.win_cnt, 0),
         singles_pts     = coalesce(hs.last_pts, 1000),
         doubles_pts     = coalesce(hd.last_pts, 1000),
         singles_matches = coalesce(s.s_cnt, 0),
         singles_wins    = coalesce(s.s_win, 0),
         doubles_matches = coalesce(s.d_cnt, 0),
         doubles_wins    = coalesce(s.d_win, 0)
    from public.profiles p2
    left join lateral (
      select eh.pts_after as last_pts from public.elo_history eh
      where eh.player_id = p2.id order by eh.id desc limit 1
    ) h on true
    left join lateral (
      select eh.kind_pts_after as last_pts from public.elo_history eh
      where eh.player_id = p2.id and eh.kind = 'singles' order by eh.id desc limit 1
    ) hs on true
    left join lateral (
      select eh.kind_pts_after as last_pts from public.elo_history eh
      where eh.player_id = p2.id and eh.kind = 'doubles' order by eh.id desc limit 1
    ) hd on true
    left join lateral (
      select count(*) as cnt,
             count(*) filter (where mp.team = m.winner_team) as win_cnt,
             count(*) filter (where m.kind = 'singles') as s_cnt,
             count(*) filter (where m.kind = 'singles' and mp.team = m.winner_team) as s_win,
             count(*) filter (where m.kind = 'doubles') as d_cnt,
             count(*) filter (where m.kind = 'doubles' and mp.team = m.winner_team) as d_win
      from public.match_players mp
      join public.matches m on m.id = mp.match_id and m.status = 'confirmed'
      where mp.player_id = p2.id
    ) s on true
   where p.id = p2.id;
end $$;

-- ─────────────────────────────────────────────
-- 6. 종목별 랭킹 뷰 (해당 종목 1경기 이상만 순위에 올림)
-- ─────────────────────────────────────────────
create or replace view public.rankings_singles
with (security_invoker = true) as
select p.id, p.nickname, p.emoji, p.region, p.ntrp,
       p.singles_pts as pts, p.singles_matches as matches, p.singles_wins as wins,
       rank() over (order by p.singles_pts desc, p.singles_wins desc, p.id) as rank
from public.profiles p
where p.deleted_at is null and p.singles_matches > 0;

create or replace view public.rankings_doubles
with (security_invoker = true) as
select p.id, p.nickname, p.emoji, p.region, p.ntrp,
       p.doubles_pts as pts, p.doubles_matches as matches, p.doubles_wins as wins,
       rank() over (order by p.doubles_pts desc, p.doubles_wins desc, p.id) as rank
from public.profiles p
where p.deleted_at is null and p.doubles_matches > 0;
