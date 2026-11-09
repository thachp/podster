-- Explore pages newest published first, then by handle (M4 step 7), so its cursor names only public values: a publish time
-- and a handle, never a room's ID. These replace step 6's two indexes, which ordered by room ID.
DROP INDEX public_workroom_index_newest;
DROP INDEX public_workroom_index_topic;
CREATE INDEX public_workroom_index_explore ON public_workroom_index (published_at DESC, public_handle) WHERE listed = 1;
CREATE INDEX public_workroom_index_explore_topic ON public_workroom_index (topic, published_at DESC, public_handle) WHERE listed = 1;
