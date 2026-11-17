-- When an approval of a release under this label first held (M6 step 6, 6f), as the room marked it. The
-- repository-unpublish ceiling counts only rooms with such a label as rooms with apps, so a room that only asked for a
-- release isn't counted. A read model: it never authorizes, and the room's own state gives every answer.
ALTER TABLE app_label_index ADD COLUMN approved_at INTEGER;
