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
