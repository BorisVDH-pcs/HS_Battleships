-- Wording pass on the broadcast lines. No behaviour, no payloads, no grants --
-- `discord_line` is a pure formatter, so this file is the whole change.
--
--   * slot_freed said "A slot is free to claim.", which described the schema
--     rather than the thing the player has to do next. It now names the tile
--     and asks for the next claim outright.
--   * evidence_submitted trailed "-- N tile(s) left to fire". N counts the
--     team's still-active claims, which is not the same number as anything on
--     screen and read as a countdown to something. Dropped; the (n/m) evidence
--     progress in the same sentence is the number that matters.
--   * score_adjusted is gone entirely. `admin_adjust_score` was dropped in 0020
--     and nothing has emitted the event since, so the branch was dead. Rows
--     predating 0020 (if any survive) now fall through to the enum name, which
--     is the honest rendering of an event this build no longer understands.
--
-- The enum value itself stays: `alter type ... drop value` does not exist in
-- Postgres, and game_events.type is the column it would have to be removed from.

create or replace function discord_line(p_event game_events)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_team text;
  v_pos  int := (p_event.payload ->> 'position')::int;
  v_at   text;
  v_img  text := nullif(btrim(coalesce(p_event.payload ->> 'image_url', '')), '');
begin
  select name into v_team from teams where id = p_event.team_id;
  v_team := coalesce(v_team, 'Someone');

  if v_pos is not null then
    v_at := ' at ' || chr(65 + ((v_pos - 1) % 10)) || (((v_pos - 1) / 10) + 1);
  else
    v_at := '';
  end if;

  return case p_event.type
    when 'fleet_placed'  then format('**%s**''s fleet is set.', v_team)
    when 'game_started'  then '**The game has begun** — fleets are locked.'
    when 'team_renamed'  then format('%s is now **%s**.',
                                     coalesce(p_event.payload ->> 'old_name', 'A team'),
                                     coalesce(p_event.payload ->> 'new_name', v_team))
    when 'tile_claimed'  then format('**%s** locked in a tile%s.', v_team, v_at)
    when 'claim_released' then format('An admin released **%s**''s tile%s.', v_team, v_at)
    when 'shot_fired'    then format('**%s** fired%s — %s', v_team, v_at,
                                     case when p_event.payload ->> 'result' = 'hit'
                                          then '**HIT**' else 'miss.' end)
    when 'ship_sunk'     then format(':boom: **%s** sank a %s-tile ship!',
                                     v_team, p_event.payload ->> 'size')
    when 'game_won'      then format(':trophy: **%s** wins — the enemy fleet is gone.', v_team)
    when 'game_reset'    then case when (p_event.payload ->> 'fleets_cleared')::boolean
                                   then 'The game has been reset — fleets need placing again.'
                                   else 'The game has been reset. Fleets are unchanged.' end
    when 'evidence_submitted' then format('**%s** submitted proof for **%s** (%s/%s).',
                                     coalesce(p_event.payload ->> 'uploaded_by_name', v_team),
                                     coalesce(p_event.payload ->> 'tile_name', 'a tile'),
                                     p_event.payload ->> 'evidence_count',
                                     p_event.payload ->> 'required_evidence')
                                   || case when v_img is not null then E'\n' || v_img else '' end
    when 'slot_freed'    then 'An active tile is available now. Lock in another target.'
    when 'pet_jar_submitted' then format(':jar: **%s** submitted a pet/jar — %s pet jar preview(s) now.',
                                     coalesce(p_event.payload ->> 'submitted_by_name', v_team),
                                     p_event.payload ->> 'pet_jar_count')
                                   || case when v_img is not null then E'\n' || v_img else '' end
    when 'pet_jar_spent' then format(':mag: A pet jar preview was spent on **%s** — %s left.',
                                     coalesce(p_event.payload ->> 'tile_name', 'a tile'),
                                     p_event.payload ->> 'pet_jar_count')
    else p_event.type::text
  end;
end;
$$;

-- `create or replace` keeps the existing grants; restated so a database built
-- from these files in order ends up identical to this one.
revoke execute on function discord_line(game_events) from public, anon, authenticated;
