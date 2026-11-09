//! The room's answers to the public read (M4 step 7, ADR 0008): its page, and its Explore entry. Both build the view from the
//! room's current state in `podster_policy::public`, which decides whether it's public now. Anything it refuses is the same
//! not-found as a missing room.
//!
//! These run before the room resolves a caller, because the page's reader may be nobody. No member, task, message, file,
//! invitation or event is read: only `room_state`'s rows, which the policy picks fields from.
use super::*;
use podster_policy::public::{explore_entry, room_page, RoomPageReader, SignedInReader};

/// The room page's path: anyone, signed in or not. The Worker sends no caller header for a public reader.
pub(crate) const INTERNAL_PUBLIC_PAGE: &str = "/internal/public-page";
/// One Explore candidate, confirmed: signed-in readers only (decision 155).
pub(crate) const INTERNAL_EXPLORE_ENTRY: &str = "/internal/explore-entry";

/// The handle the Worker found the room by, from the internal request's query. Reads are GETs, so they never arm the room.
fn handle_of(url: &Url) -> R<String> {
    url.query_pairs()
        .find(|(key, _)| key == "handle")
        .map(|(_, value)| value.into_owned())
        .ok_or_else(ApiError::workspace_not_found)
}

fn signed_in(caller: &Identity) -> SignedInReader {
    SignedInReader {
        id: caller.id.clone(),
        kind: parse_kind(&caller.kind),
    }
}

fn view_json(view: Option<podster_policy::public::PublicWorkroomView>) -> R<Value> {
    let view = view.ok_or_else(ApiError::workspace_not_found)?;
    serde_json::from_str(&view.to_json()).map_err(|_| ApiError::internal("public view json"))
}

/// The page, for `reader`, if the room is public under `handle` now.
pub(super) fn page(
    sql: &SqlStorage,
    reader: Option<&Identity>,
    public_rooms_enabled: bool,
    url: &Url,
) -> R<Value> {
    let handle = handle_of(url)?;
    let reader = match reader {
        Some(caller) => RoomPageReader::SignedIn(signed_in(caller)),
        None => {
            RoomPageReader::Public(podster_policy::public::PublicCaller::from_public_assertion())
        }
    };
    let state = visibility::room_state(sql)?;
    view_json(room_page(&reader, public_rooms_enabled, &state, &handle))
}

/// The room's Explore entry, for a signed-in reader, if it's public under `handle` now and not archived.
pub(super) fn explore(
    sql: &SqlStorage,
    reader: &Identity,
    public_rooms_enabled: bool,
    url: &Url,
) -> R<Value> {
    let handle = handle_of(url)?;
    let state = visibility::room_state(sql)?;
    view_json(explore_entry(
        &signed_in(reader),
        public_rooms_enabled,
        &state,
        &handle,
    ))
}
