-- ============================================================
--  BABY GINOS · ADS READER  ·  Esquema Supabase
--  Pegá TODO esto en Supabase → SQL Editor → Run
-- ============================================================

-- Tabla 1: un registro por anuncio (la "ficha" del anuncio)
create table if not exists ads (
  ad_id            text primary key,        -- id del anuncio en Meta
  ad_code          text,                    -- tu código numérico (ej. BG-0347), opcional
  ad_name          text,
  campaign_name    text,
  objective        text,                    -- objetivo de la campaña (ventas, tráfico, etc.)
  funnel           text,                    -- TOF / MOF / BOF (lo calcula la app)
  status           text default 'nuevo',    -- nuevo | activo | ganador | fatigando
  baseline_ctr     numeric,                 -- CTR de la semana 1 (congelado)
  baseline_cpm     numeric,
  baseline_locked  boolean default false,   -- true cuando ya se fijó el baseline
  first_seen       date default current_date,
  updated_at       timestamptz default now()
);

-- Tabla 2: una fila por anuncio POR DÍA (el histórico = la memoria del sistema)
create table if not exists ad_snapshots (
  ad_id        text references ads(ad_id) on delete cascade,
  day          date not null,
  spend        numeric,
  cpm          numeric,
  frequency    numeric,
  ctr          numeric,
  impressions  bigint,
  reach        bigint,
  results      numeric,                     -- resultados del objetivo (ej. compras)
  cost_per_result numeric,
  primary key (ad_id, day)                  -- evita duplicar el mismo día
);

-- Índice para consultar rápido por fecha
create index if not exists idx_snapshots_day on ad_snapshots(day);

-- Nota: este proyecto usa la SERVICE ROLE key desde el servidor (Netlify),
-- así que no hace falta configurar políticas RLS para el sync.
-- Si más adelante conectás un panel público, ahí sí agregás RLS.
