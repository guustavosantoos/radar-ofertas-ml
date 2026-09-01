-- ==============================================================================
-- RADAR DE OFERTAS ML — SUPABASE SCHEMA & SECURITY POLICIES (RLS)
-- ==============================================================================

-- 1. TABELA DE PERFIS DE USUÁRIO (PROFILES)
-- Conectada automaticamente à tabela auth.users do Supabase Auth
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  full_name text,
  affiliate_tag text default 'gustavobraulio',
  created_at timestamptz default timezone('utc'::text, now()) not null,
  updated_at timestamptz default timezone('utc'::text, now()) not null
);

-- Ativação de Segurança RLS
alter table public.profiles enable row level security;

create policy "Usuários podem visualizar o próprio perfil"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Usuários podem atualizar o próprio perfil"
  on public.profiles for update
  using (auth.uid() = id);

create policy "Usuários podem inserir o próprio perfil"
  on public.profiles for insert
  with check (auth.uid() = id);

-- Trigger para criar perfil automaticamente ao cadastrar no Supabase Auth
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, affiliate_tag)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    'gustavobraulio'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();


-- 2. TABELA DE TEMPLATES PERSONALIZADOS DE MENSAGENS (CUSTOM_TEMPLATES)
create table if not exists public.custom_templates (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  title text not null,
  template_text text not null,
  category text default 'geral',
  created_at timestamptz default timezone('utc'::text, now()) not null,
  updated_at timestamptz default timezone('utc'::text, now()) not null
);

-- Ativação de Segurança RLS
alter table public.custom_templates enable row level security;

create policy "Usuários podem ver apenas seus próprios templates"
  on public.custom_templates for select
  using (auth.uid() = user_id);

create policy "Usuários podem criar templates próprios"
  on public.custom_templates for insert
  with check (auth.uid() = user_id);

create policy "Usuários podem atualizar seus próprios templates"
  on public.custom_templates for update
  using (auth.uid() = user_id);

create policy "Usuários podem deletar seus próprios templates"
  on public.custom_templates for delete
  using (auth.uid() = user_id);


-- 3. TABELA DE GRUPOS DO WHATSAPP (WHATSAPP_GROUPS)
create table if not exists public.whatsapp_groups (
  id text not null,
  user_id uuid references auth.users on delete cascade not null,
  name text not null,
  participants_count integer default 0,
  created_at timestamptz default timezone('utc'::text, now()) not null,
  primary key (id, user_id)
);

-- Ativação de Segurança RLS
alter table public.whatsapp_groups enable row level security;

create policy "Usuários podem ver apenas seus grupos cadastrados"
  on public.whatsapp_groups for select
  using (auth.uid() = user_id);

create policy "Usuários podem adicionar seus grupos"
  on public.whatsapp_groups for insert
  with check (auth.uid() = user_id);

create policy "Usuários podem deletar seus grupos"
  on public.whatsapp_groups for delete
  using (auth.uid() = user_id);


-- 4. TABELA DE OFERTAS SALVAS / FAVORITAS (SAVED_DEALS)
create table if not exists public.saved_deals (
  id text not null,
  user_id uuid references auth.users on delete cascade not null,
  title text not null,
  price numeric not null,
  original_price numeric,
  discount_percentage integer,
  free_shipping boolean default false,
  url text not null,
  affiliate_url text,
  thumbnail text,
  created_at timestamptz default timezone('utc'::text, now()) not null,
  primary key (id, user_id)
);

-- Ativação de Segurança RLS
alter table public.saved_deals enable row level security;

create policy "Usuários podem gerenciar apenas suas ofertas salvas"
  on public.saved_deals for all
  using (auth.uid() = user_id);


-- 5. TABELA DE CONFIGURAÇÕES DO USUÁRIO (USER_SETTINGS)
create table if not exists public.user_settings (
  user_id uuid references auth.users on delete cascade primary key,
  min_discount_percentage integer default 20,
  auto_post boolean default false,
  affiliate_tag text default 'gustavobraulio',
  selected_template_id text default 'achadinhos',
  active_categories jsonb default '["MLB1051", "MLB1648", "MLB1000", "MLB1430"]'::jsonb,
  updated_at timestamptz default timezone('utc'::text, now()) not null
);

-- Ativação de Segurança RLS
alter table public.user_settings enable row level security;

create policy "Usuários podem gerenciar suas configurações"
  on public.user_settings for all
  using (auth.uid() = user_id);
