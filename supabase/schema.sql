create extension if not exists pgcrypto;

create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (char_length(full_name) between 2 and 120),
  phone text not null unique,
  created_at timestamptz not null default now(),
  active boolean not null default true
);

create table if not exists public.fitness_classes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null check (category in ('yoga','spinning','zumba','functional','pilates','other')),
  description text not null default '',
  duration_minutes integer not null check (duration_minutes between 10 and 240),
  price_mxn numeric(10,2) not null check (price_mxn >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.class_sessions (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.fitness_classes(id),
  starts_at timestamptz not null,
  capacity integer not null check (capacity > 0),
  reserved_count integer not null default 0 check (reserved_count >= 0 and reserved_count <= capacity),
  instructor text,
  created_at timestamptz not null default now()
);
create index if not exists class_sessions_starts_at_idx on public.class_sessions(starts_at);
create unique index if not exists class_sessions_class_start_key on public.class_sessions(class_id,starts_at);

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.class_sessions(id),
  member_id uuid not null references public.members(id),
  status text not null default 'pending_confirmation' check (status in ('pending_confirmation','confirmed','cancelled','waitlisted','attended','no_show')),
  quoted_price_mxn numeric(10,2) not null check (quoted_price_mxn >= 0),
  created_at timestamptz not null default now(),
  unique(session_id, member_id)
);
create index if not exists bookings_session_status_idx on public.bookings(session_id,status);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  member_id uuid references public.members(id),
  booking_id uuid references public.bookings(id),
  description text not null,
  amount_mxn numeric(10,2) not null check (amount_mxn > 0),
  due_on date not null,
  paid_at timestamptz,
  method text not null check (method in ('cash','card','transfer','other')),
  status text not null default 'pending' check (status in ('pending','paid','cancelled','failed')),
  reference text,
  created_at timestamptz not null default now()
);
create index if not exists payments_due_on_idx on public.payments(due_on,status);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  description text not null,
  amount_mxn numeric(10,2) not null check (amount_mxn > 0),
  due_on date not null,
  paid_at timestamptz,
  method text not null check (method in ('cash','card','transfer','other')),
  status text not null default 'pending' check (status in ('pending','paid','cancelled')),
  category text not null default 'general',
  reference text,
  created_at timestamptz not null default now()
);
create index if not exists expenses_due_on_idx on public.expenses(due_on,status);

create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings(id),
  attended boolean not null,
  checked_at timestamptz not null default now(),
  checked_by text
);

-- Al cambiar a estado cancelado, libera un lugar. UPDATE bloquea la fila de sesión
-- y evita que dos reservas simultáneas excedan la capacidad.
create or replace function public.adjust_session_capacity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' and new.status in ('pending_confirmation','confirmed') then
    update class_sessions set reserved_count = reserved_count + 1
      where id = new.session_id and reserved_count < capacity;
    if not found then raise exception 'CLASS_FULL'; end if;
  elsif tg_op = 'UPDATE' and old.status in ('pending_confirmation','confirmed','attended','no_show') and new.status not in ('pending_confirmation','confirmed','attended','no_show') then
    update class_sessions set reserved_count = greatest(0,reserved_count - 1) where id = old.session_id;
  elsif tg_op = 'UPDATE' and old.status not in ('pending_confirmation','confirmed','attended','no_show') and new.status in ('pending_confirmation','confirmed','attended','no_show') then
    update class_sessions set reserved_count = reserved_count + 1
      where id = new.session_id and reserved_count < capacity;
    if not found then raise exception 'CLASS_FULL'; end if;
  end if;
  return new;
end;
$$;
drop trigger if exists bookings_capacity_trigger on public.bookings;
create trigger bookings_capacity_trigger before insert or update of status on public.bookings
for each row execute function public.adjust_session_capacity();

create or replace function public.book_class(p_session_id uuid, p_member_name text, p_phone text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_member_id uuid;
  v_booking_id uuid;
  v_price numeric(10,2);
begin
  if char_length(trim(p_member_name)) < 2 or char_length(p_member_name) > 120 then raise exception 'INVALID_NAME'; end if;
  insert into members(full_name,phone) values (trim(p_member_name),trim(p_phone))
    on conflict(phone) do update set full_name = excluded.full_name returning id into v_member_id;
  select c.price_mxn into v_price from class_sessions s join fitness_classes c on c.id=s.class_id
    where s.id=p_session_id and c.active=true and s.starts_at>now();
  if v_price is null then raise exception 'SESSION_NOT_FOUND'; end if;
  insert into bookings(session_id,member_id,status,quoted_price_mxn)
    values(p_session_id,v_member_id,'pending_confirmation',v_price) returning id into v_booking_id;
  return v_booking_id;
end;
$$;
revoke all on function public.book_class(uuid,text,text) from public, anon, authenticated;
grant execute on function public.book_class(uuid,text,text) to service_role;

-- Desactiva el acceso directo de clientes; las funciones del servidor usan la clave
-- privada de Supabase y son el único canal de acceso en este starter.
do $$
declare t text;
begin
  foreach t in array array['members','fitness_classes','class_sessions','bookings','payments','expenses','attendance'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
  end loop;
end $$;

-- Configuración de ejemplo: sustituye los valores por horarios y precios reales.
insert into public.fitness_classes(name,category,description,duration_minutes,price_mxn) values
 ('Yoga','yoga','Movilidad, respiración y fuerza consciente.',60,120),
 ('Spinning','spinning','Ciclismo indoor por intervalos.',45,120),
 ('Zumba','zumba','Baile fitness para todos los niveles.',50,120),
 ('Entrenamiento funcional','functional','Fuerza y acondicionamiento general.',50,120),
 ('Pilates','pilates','Control postural y fortalecimiento del core.',55,120)
on conflict do nothing;

-- Agenda de muestra por 14 días (lunes a viernes), hora local de San Luis Potosí.
-- Puedes borrar estas sesiones y sustituirlas por la agenda real del estudio.
insert into public.class_sessions(class_id,starts_at,capacity)
select c.id, make_timestamptz(extract(year from d.day)::int,extract(month from d.day)::int,extract(day from d.day)::int,slot.hour,slot.minute,0,'America/Mexico_City'),slot.capacity
from fitness_classes c
cross join generate_series(current_date::timestamp,(current_date+13)::timestamp,interval '1 day') as d(day)
cross join (values ('yoga',7,0,12),('yoga',18,0,12),('spinning',7,0,15),('spinning',19,0,15),('zumba',8,0,20),('zumba',18,30,20),('functional',9,0,12),('functional',17,30,12),('pilates',10,0,10),('pilates',17,0,10)) as slot(category,hour,minute,capacity)
where c.category=slot.category and extract(isodow from d.day) between 1 and 5
on conflict do nothing;

