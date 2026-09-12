-- A boss that already has its two takes no more.
--
-- Found by playing H2 in the builder's tester: Bandos hilt could be submitted a
-- third time into a General Graardor group that was already finished. The tile
-- did not move -- `claim_is_complete()` has always been right about that, since
-- a full group cannot be made fuller -- but the screenshot was accepted and
-- banked a point that bought nothing.
--
-- The player's own picker has always closed that group: `points_per_set` is one
-- of the rules `unavailableSetOptionIds()` shuts down, and the card draws the
-- set as "General Graardor — ✓ Done" with its drops unselectable. So nobody
-- could reach this by accident. But the browser was the ONLY thing stopping
-- them, which is the shape of every rule this repo deliberately puts in the
-- database instead: RLS and the definer functions exist so that there is no
-- request a player can craft to get around what the interface shows them.
--
-- `each_set` already refused this, through the group-quota check. The two rules
-- differ on whether a REPEAT counts, not on whether a finished group stays
-- open, so the refusal belongs to both -- it just measures the group the way
-- each rule measures it: distinct options for `each_set`, banked points for
-- `points_per_set`.

create or replace function evidence_refusal(p_claim_id uuid, p_option_id uuid)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_tile  tiles%rowtype;
  v_opt   tile_options%rowtype;
  v_used  int;
  v_group text;
  v_have  int;
begin
  select t.* into v_tile
    from tiles t
    join tile_claims c on c.tile_id = t.id
   where c.id = p_claim_id;
  if not found then return 'No such tile claim'; end if;

  select * into v_opt from tile_options
   where id = p_option_id and tile_id = v_tile.id;
  if not found then return 'That is not one of this tile''s options'; end if;

  -- On a set tile a repeat is worth nothing, so it is refused rather than
  -- silently banked: a team that submits the same piece twice believing it
  -- counted would find out only when the tile failed to fire.
  if v_tile.completion in ('one_set', 'each_set') and exists (
       select 1 from tile_evidence
        where claim_id = p_claim_id and option_id = p_option_id
     ) then
    return format('You have already submitted %s for this tile', v_opt.label);
  end if;

  -- A capped drop stops counting once it has been counted its number of times.
  if v_opt.max_times is not null then
    select count(*) into v_used from tile_evidence
     where claim_id = p_claim_id and option_id = p_option_id;
    if v_used >= v_opt.max_times then
      return format('%s counts %s time(s) on this tile, and you have them all',
                    v_opt.label, v_opt.max_times);
    end if;
  end if;

  v_group := coalesce(v_opt.grp, v_opt.label);

  -- An each_set group that already has its quota of DIFFERENT drops takes no
  -- more. Wording matched to the trigger's, since either may be what a player
  -- actually sees.
  if v_tile.completion = 'each_set' then
    select count(distinct e.option_id) into v_have
      from tile_evidence e
      join tile_options o on o.id = e.option_id
     where e.claim_id = p_claim_id
       and coalesce(o.grp, o.label) = v_group;
    if v_have >= v_tile.per_set then
      return 'You already have enough different drops from this group';
    end if;
  end if;

  -- And the same group under `points_per_set`, measured the way that rule
  -- measures it: by the points banked into it, repeats included. A group at
  -- its target cannot be moved by anything else from that boss, so offering
  -- to accept one is offering to waste a screenshot.
  --
  -- Only meaningful where the group is actually a group. An ungrouped option
  -- is its own group under these rules, and closing it here would be the
  -- `max_times` cap by another name -- one the tile never asked for.
  if v_tile.completion = 'points_per_set' then
    select coalesce(sum(e.points), 0) into v_have
      from tile_evidence e
      join tile_options o on o.id = e.option_id
     where e.claim_id = p_claim_id
       and coalesce(o.grp, o.label) = v_group;
    if v_have >= v_tile.per_set then
      return format('%s already has its %s — nothing more from there counts',
                    v_group, v_tile.per_set);
    end if;
  end if;

  return null;
end;
$$;

revoke execute on function evidence_refusal(uuid, uuid) from public, anon, authenticated;
