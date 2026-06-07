create table if not exists runs (
  id text primary key,
  agent text not null,
  source text not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists checks (
  id text primary key,
  run_id text not null references runs(id),
  spec_id text not null,
  spec_version text not null,
  passed boolean not null,
  results jsonb not null,
  evaluated_at timestamptz not null
);

create table if not exists drift_events (
  id text primary key,
  spec_id text not null,
  spec_version text not null,
  run_id text not null references runs(id),
  failed jsonb not null,
  detected_at timestamptz not null
);

create table if not exists failure_corpus (
  id text primary key,
  vertical text not null,
  spec_id text not null,
  run_id text not null references runs(id),
  label text not null,
  trace jsonb not null,
  created_at timestamptz not null default now()
);

