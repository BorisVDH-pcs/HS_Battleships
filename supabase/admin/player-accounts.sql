-- HS_Battleships — admin snippets for player accounts
--
-- Run these in the Supabase SQL Editor (service role). They are NOT functions
-- exposed to the app: creating accounts and resetting passwords must never be
-- reachable from the browser.
--
-- Players sign in with a username only. The address stored in auth.users is
-- synthetic and derived from that username — see web/src/lib/auth.js:
--
--     username  ->  lower(username), spaces to '_', strip other punctuation
--     email     ->  <that>@players.hs-battleships.invalid
--
-- e.g. "Lil Sod" -> lil_sod@players.hs-battleships.invalid


-- ============================================================
-- Create a player account
-- ============================================================
-- Sets email_confirmed_at so the account works even while "Confirm email" is
-- still enabled in Auth settings, and fills the token columns GoTrue cannot
-- read as NULL (leaving them null causes "Database error querying schema").
-- The on_auth_user_created trigger creates the matching profiles row.

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  confirmation_token, recovery_token, email_change,
  email_change_token_new, email_change_token_current,
  phone_change, phone_change_token, reauthentication_token
)
values (
  gen_random_uuid(),
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated',
  -- vvv edit these two vvv
  'lil_sod' || '@players.hs-battleships.invalid',
  crypt('choose-a-password', gen_salt('bf')),
  now(), now(), now(),
  '{"provider":"email","providers":["email"]}',
  -- display_name is what shows in the feed; keep the real spelling
  jsonb_build_object('display_name', 'Lil Sod', 'rsn', 'Lil Sod'),
  '', '', '', '', '', '', '', ''
);


-- ============================================================
-- Create the dedicated ADMIN account
-- ============================================================
-- Keep this separate from your own player account. An admin can read every
-- tile's task and both fleets (admin_list_tiles / admin_list_ship_cells), so an
-- account that both runs the event and plays in it would be able to see the
-- answers for its own team. Separate accounts keep that impossible rather than
-- merely discouraged.
--
-- Sign in with the username, same as any player — the difference is only the
-- is_admin flag. Do not add this account to a team; the roster picker hides
-- admin accounts for exactly that reason.

-- Paste the whole block into the Supabase SQL Editor and edit only the three
-- variables at the top. The address and the profiles lookup are derived from
-- them, so the username cannot drift out of sync with what the grant targets.

do $$
declare
  -- vvv EDIT THESE THREE LINES ONLY vvv
  v_password     text := 'CHANGE-THIS-TO-A-STRONG-PASSWORD';  -- must change
  v_username     text := 'hs_admin';                          -- typed at login
  v_display_name text := 'HS Admin';                          -- shown in the app
  -- ^^^ nothing below needs editing ^^^
begin
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change,
    email_change_token_new, email_change_token_current,
    phone_change, phone_change_token, reauthentication_token
  )
  values (
    gen_random_uuid(),
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated',
    -- Must match how the app derives the address from a username
    -- (see web/src/lib/auth.js): lowercased, spaces to underscores.
    lower(replace(v_username, ' ', '_')) || '@players.hs-battleships.invalid',
    crypt(v_password, gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}',
    jsonb_build_object('display_name', v_display_name),
    '', '', '', '', '', '', '', ''
  );

  -- The on_auth_user_created trigger has already made the profiles row by here,
  -- inside this same transaction. The flag is deliberately NOT settable from the
  -- app: the profiles_self policy blocks a user changing their own is_admin.
  update profiles set is_admin = true where display_name = v_display_name;
end $$;

-- Should return exactly one row. Zero rows means the display name did not match.
select display_name, is_admin from profiles where is_admin;

-- Revoke:
-- update profiles set is_admin = false where display_name = 'HS Admin';


-- ============================================================
-- Reset a player's password
-- ============================================================
-- There is no self-service reset (no real mailbox), so this is the mechanism.

update auth.users
   set encrypted_password = crypt('new-password-here', gen_salt('bf'))
 where email = 'lil_sod@players.hs-battleships.invalid';


-- ============================================================
-- Put a player on a team
-- ============================================================
-- role 'captain' additionally allows placing the fleet.

insert into team_members (team_id, profile_id, role)
select t.id, p.id, 'member'
  from teams t
  join games g on g.id = t.game_id
  join profiles p on p.display_name = 'Lil Sod'
 where g.name = 'Demo Match' and t.name = 'Kriegsmarine'
on conflict (team_id, profile_id) do update set role = excluded.role;


-- ============================================================
-- Who is registered, and where are they?
-- ============================================================

select p.display_name, u.email, t.name as team, tm.role
  from profiles p
  join auth.users u on u.id = p.id
  left join team_members tm on tm.profile_id = p.id
  left join teams t on t.id = tm.team_id
 order by p.display_name;
