-- ============================================================
-- The paste box, gone
-- ============================================================
-- The board builder is now the only way a board gets built -- nobody types a
-- hundred lines by hand any more, and the read-only "show as list" view that
-- sat beside the paste box was proofreading for exactly that: checking a
-- paste landed correctly. Neither has a reason to exist once the paste box
-- does not.
--
-- `admin_set_tiles` was that paste box's only caller. Everything it wrote --
-- catalogue entries, `library_id` links -- the board builder already writes
-- on its own, square by square, so nothing downstream loses a capability by
-- this going.

drop function if exists admin_set_tiles(uuid, jsonb);
