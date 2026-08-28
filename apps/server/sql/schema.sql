-- Documents are stored as a compacted snapshot plus an append-only log of the
-- updates that came after it. Writes only ever append; compaction folds the tail
-- back into the snapshot and truncates the log.

create table if not exists documents (
  id          text primary key,
  created_at  timestamptz not null default now()
);

create table if not exists document_snapshots (
  document_id text primary key references documents(id) on delete cascade,
  -- Y.encodeStateAsUpdate output: the whole document as one binary update.
  state       bytea  not null,
  -- Updates at or below this sequence are already folded into `state`.
  through_seq bigint not null,
  created_at  timestamptz not null default now()
);

create table if not exists document_updates (
  document_id text   not null references documents(id) on delete cascade,
  seq         bigint not null generated always as identity,
  payload     bytea  not null,
  created_at  timestamptz not null default now(),
  primary key (document_id, seq)
);

-- Every read is "the updates for this document, in order, after some sequence".
create index if not exists document_updates_replay_idx
  on document_updates (document_id, seq);
