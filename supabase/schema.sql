-- Enable extensions
create extension if not exists "pgcrypto";

-- Profiles
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

-- Settings
create table if not exists public.app_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  intervals int[] not null default array[1,3,7,14,30,60,120,240,360,540,720],
  default_created_date_mode text not null default 'today',
  show_paused_by_default boolean not null default false,
  show_deleted_by_default boolean not null default false,
  revised_items_stay_visible boolean not null default true,
  updated_at timestamptz not null default now()
);

-- Revision items
create table if not exists public.revision_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subject text not null,
  page_number text,
  chapter_name text,
  note text,
  tags text[] not null default '{}',
  priority int not null default 0,
  created_date date not null,
  last_review_date date not null,
  current_stage int not null default 0,
  next_due_date date,
  planned_dates jsonb not null default '[]'::jsonb,
  paused boolean not null default false,
  carry_priority int not null default 0,
  revision_count int not null default 0,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists revision_items_user_id_idx on public.revision_items(user_id);
create index if not exists revision_items_user_due_idx on public.revision_items(user_id, next_due_date);
create index if not exists revision_items_user_subject_idx on public.revision_items(user_id, subject);
create index if not exists revision_items_user_deleted_idx on public.revision_items(user_id, deleted_at);

-- History
create table if not exists public.revision_history (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references public.revision_items(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  performed_on date not null,
  performed_at timestamptz not null default now(),
  meta jsonb not null default '{}'::jsonb,
  snapshot jsonb
);

create index if not exists revision_history_user_id_idx on public.revision_history(user_id);
create index if not exists revision_history_item_id_idx on public.revision_history(item_id);

-- Updated-at helper
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_revision_items_updated_at on public.revision_items;
create trigger trg_revision_items_updated_at
before update on public.revision_items
for each row execute function public.set_updated_at();

drop trigger if exists trg_app_settings_updated_at on public.app_settings;
create trigger trg_app_settings_updated_at
before update on public.app_settings
for each row execute function public.set_updated_at();

-- Row level security
alter table public.profiles enable row level security;
alter table public.app_settings enable row level security;
alter table public.revision_items enable row level security;
alter table public.revision_history enable row level security;

-- Policies
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
for select using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
for insert with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
for update using (auth.uid() = id);

drop policy if exists "settings_select_own" on public.app_settings;
create policy "settings_select_own" on public.app_settings
for select using (auth.uid() = user_id);

drop policy if exists "settings_insert_own" on public.app_settings;
create policy "settings_insert_own" on public.app_settings
for insert with check (auth.uid() = user_id);

drop policy if exists "settings_update_own" on public.app_settings;
create policy "settings_update_own" on public.app_settings
for update using (auth.uid() = user_id);

drop policy if exists "items_select_own" on public.revision_items;
create policy "items_select_own" on public.revision_items
for select using (auth.uid() = user_id);

drop policy if exists "items_insert_own" on public.revision_items;
create policy "items_insert_own" on public.revision_items
for insert with check (auth.uid() = user_id);

drop policy if exists "items_update_own" on public.revision_items;
create policy "items_update_own" on public.revision_items
for update using (auth.uid() = user_id);

drop policy if exists "items_delete_own" on public.revision_items;
create policy "items_delete_own" on public.revision_items
for delete using (auth.uid() = user_id);

drop policy if exists "history_select_own" on public.revision_history;
create policy "history_select_own" on public.revision_history
for select using (auth.uid() = user_id);

drop policy if exists "history_insert_own" on public.revision_history;
create policy "history_insert_own" on public.revision_history
for insert with check (auth.uid() = user_id);

drop policy if exists "history_update_own" on public.revision_history;
create policy "history_update_own" on public.revision_history
for update using (auth.uid() = user_id);

drop policy if exists "history_delete_own" on public.revision_history;
create policy "history_delete_own" on public.revision_history
for delete using (auth.uid() = user_id);
