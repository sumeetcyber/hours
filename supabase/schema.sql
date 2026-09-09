create table if not exists public.user_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{"pursuits":[],"entries":[],"active":null,"theme":"system","wishfulDefault":8}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_state enable row level security;

-- Defense-in-depth policies. The web server uses the server-only key, but the
-- database remains correctly scoped if a future client/API path is added.
drop policy if exists "user_state_select_own" on public.user_state;
drop policy if exists "user_state_insert_own" on public.user_state;
drop policy if exists "user_state_update_own" on public.user_state;
drop policy if exists "user_state_delete_own" on public.user_state;
create policy "user_state_select_own" on public.user_state for select to authenticated using (auth.uid()=user_id);
create policy "user_state_insert_own" on public.user_state for insert to authenticated with check (auth.uid()=user_id);
create policy "user_state_update_own" on public.user_state for update to authenticated using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy "user_state_delete_own" on public.user_state for delete to authenticated using (auth.uid()=user_id);

grant select,insert,update,delete on public.user_state to authenticated;
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='user_state') then
    alter publication supabase_realtime add table public.user_state;
  end if;
end $$;

create table if not exists public.guest_state (
  guest_id uuid primary key,
  state jsonb not null default '{"pursuits":[],"entries":[],"active":null,"theme":"system","wishfulDefault":8}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.guest_state enable row level security;

revoke all on public.guest_state from anon, authenticated;
