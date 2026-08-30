-- handle_new_user() is a trigger function on auth.users, but living in the public
-- schema made it callable as an RPC at /rest/v1/rpc/handle_new_user by anon and
-- authenticated alike. Calling it directly errors out (it dereferences NEW, which
-- is unassigned outside a trigger), so it was not exploitable — but a
-- security definer function reachable by anonymous callers is not something to
-- leave lying around, and the next edit to it could make it matter.
--
-- Triggers ignore EXECUTE grants: they run as the table owner regardless, so
-- revoking here does not affect sign-up.

revoke execute on function public.handle_new_user() from public, anon, authenticated;
