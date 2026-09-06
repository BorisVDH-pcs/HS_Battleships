-- Once an each_set group has supplied its required number of distinct drops,
-- more evidence from that group cannot advance the tile. The client disables
-- those choices; this trigger is the database-side authority for every write
-- path, including clients that have not refreshed yet.

create or replace function enforce_each_set_group_quota()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_rule    tile_completion;
  v_per_set smallint;
  v_group   text;
  v_have    integer;
begin
  if new.option_id is null then return new; end if;

  select t.completion, t.per_set, coalesce(o.grp, o.label)
    into v_rule, v_per_set, v_group
    from tile_claims c
    join tiles t on t.id = c.tile_id
    join tile_options o on o.id = new.option_id and o.tile_id = t.id
   where c.id = new.claim_id;

  if v_rule <> 'each_set' then return new; end if;

  select count(distinct e.option_id)
    into v_have
    from tile_evidence e
    join tile_options o on o.id = e.option_id
   where e.claim_id = new.claim_id
     and coalesce(o.grp, o.label) = v_group;

  if v_have >= v_per_set then
    raise exception 'You already have enough different drops from this group';
  end if;

  return new;
end;
$$;

revoke execute on function enforce_each_set_group_quota() from public, anon, authenticated;

drop trigger if exists enforce_each_set_group_quota on tile_evidence;
create trigger enforce_each_set_group_quota
before insert on tile_evidence
for each row execute function enforce_each_set_group_quota();
