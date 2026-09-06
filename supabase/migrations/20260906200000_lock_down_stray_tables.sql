-- ============================================================
-- Close a hand-made backup table that was readable by the world
-- ============================================================
-- `tiles_backup_demo_match_pre_import` was created by hand before a board
-- import, never by a migration -- so it never went through the lockdown that
-- 0001 gives `tiles`. It sat in the `public` schema with RLS off, which is all
-- PostgREST needs: `/rest/v1/tiles_backup_demo_match_pre_import` returned all
-- 100 rows to `anon`, with no sign-in at all.
--
-- The tile list is the second of the two secrets this whole schema is built to
-- keep (`tiles_no_direct_read` is a flat `false` for exactly this reason), so a
-- readable copy of it defeats the real table's protection completely. Every
-- name, icon and evidence count was public for as long as the table existed.
--
-- RLS with no policy, rather than a DROP: the data is a backup somebody took on
-- purpose, and destroying it is not this migration's decision to make. Enabling
-- RLS leaves it readable only through a `service_role` connection -- the SQL
-- editor and the CLI -- and invisible to `anon` and `authenticated` alike.
-- The grants go too, so a future policy cannot accidentally re-open it.
--
-- Guarded on the table existing, because it was never created by a migration:
-- a fresh database (a `db reset`, a branch, a new environment) has no such
-- table, and an unguarded ALTER would fail the whole push there.

do $$
declare
  v_table text;
begin
  foreach v_table in array array['tiles_backup_demo_match_pre_import']
  loop
    if to_regclass(format('public.%I', v_table)) is null then
      raise notice 'skipping %, not present in this database', v_table;
      continue;
    end if;

    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on public.%I from anon, authenticated', v_table);

    raise notice 'locked down %', v_table;
  end loop;
end
$$;

-- A guard against the next one. Any table added to `public` by hand -- a
-- backup, a scratch import, a paste from the SQL editor -- is exposed the
-- moment it exists, and nothing in the repo would have caught this: the table
-- is not in any migration, so reviewing the migrations could never have found
-- it. `supabase db lint` and the dashboard advisors do catch it, under
-- `rls_disabled_in_public`.
comment on schema public is
  'Every table here is reachable over PostgREST. A new one is world-readable '
  'until RLS is enabled on it -- including tables made by hand in the SQL '
  'editor, which no migration review will ever see. Check the security '
  'advisors after any manual table creation.';
