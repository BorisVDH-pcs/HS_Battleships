-- ============================================================
-- Harden internal helpers reported by the Supabase advisor
-- ============================================================

-- relay_on_commit() is invoked only by trg_relay_game_events. It is not a
-- client RPC, so neither signed-out nor signed-in API callers need EXECUTE.
-- PostgreSQL grants new functions to PUBLIC by default unless it is revoked.
revoke execute on function public.relay_on_commit()
  from public, anon, authenticated;

-- This helper is used by the game_events RLS policy and by the private Discord
-- relay path. Pin an empty search path and qualify its enum type so PostgreSQL
-- cannot resolve an unqualified object from an unintended schema.
create or replace function public.is_team_private_event(p_type public.event_type)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_type = any(array[
    'evidence_submitted',
    'slot_freed',
    'pet_jar_submitted',
    'pet_jar_spent'
  ]::public.event_type[]);
$$;

-- RLS evaluates this helper for signed-in readers. It is intentionally
-- available to authenticated sessions, but never to PUBLIC or anon.
revoke execute on function public.is_team_private_event(public.event_type)
  from public, anon;
grant execute on function public.is_team_private_event(public.event_type)
  to authenticated;
