//! Throwaway: streams a request body to R2, counting and hashing as it goes, and holds no more than a chunk at a time.
//! It answers with how much Wasm memory the Worker reached, which is what shows it didn't buffer the file.

use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::rc::Rc;
use worker::*;

const MAX_FILE_BYTES: u64 = 100_000_000;
const WASM_PAGE_BYTES: u64 = 65_536;

#[derive(Serialize)]
struct ScanJob<'a> {
    key: &'a str,
    id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<&'a str>,
}

#[derive(Default)]
struct Progress {
    bytes: u64,
    chunks: u64,
    largest_chunk: u64,
    peak_memory: u64,
    hash: Sha256,
}

fn memory_now() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        core::arch::wasm32::memory_size(0) as u64 * WASM_PAGE_BYTES
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        WASM_PAGE_BYTES
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn answer(status: u16, body: serde_json::Value) -> Result<Response> {
    Ok(Response::from_json(&body)?.with_status(status))
}

async fn put_object(mut req: Request, env: Env, id: &str) -> Result<Response> {
    let started = Date::now().as_millis();
    let length = req
        .headers()
        .get("content-length")?
        .and_then(|value| value.parse::<u64>().ok());
    let Some(length) = length else {
        return answer(411, serde_json::json!({ "error": "length_required" }));
    };
    if length > MAX_FILE_BYTES {
        return answer(413, serde_json::json!({ "error": "too_large" }));
    }
    let Some(expected) = req.headers().get("x-sha256")? else {
        return answer(400, serde_json::json!({ "error": "sha256_required" }));
    };

    let progress = Rc::new(RefCell::new(Progress {
        peak_memory: memory_now(),
        ..Progress::default()
    }));
    let counted = progress.clone();
    let body = req.stream()?.map(move |chunk| {
        let chunk = chunk?;
        let mut seen = counted.borrow_mut();
        seen.bytes += chunk.len() as u64;
        seen.chunks += 1;
        seen.largest_chunk = seen.largest_chunk.max(chunk.len() as u64);
        seen.peak_memory = seen.peak_memory.max(memory_now());
        // The header is only a claim. This is what's enforced.
        if seen.bytes > length {
            return Err(Error::RustError("body longer than declared".into()));
        }
        seen.hash.update(chunk.as_slice());
        Ok(chunk)
    });

    let bucket = env.bucket("ASSETS")?;
    let key = format!("spike/{id}");
    let stored = bucket
        .put(&key, Data::Stream(FixedLengthStream::wrap(body, length)))
        .execute()
        .await;
    if let Err(problem) = stored {
        // Nothing is stored after a failed put, but say so in the answer, not in a guess.
        console_log!(
            "{}",
            serde_json::json!({ "at": "api", "id": id, "stored": false })
        );
        let present = bucket.head(&key).await?.is_some();
        return answer(
            422,
            serde_json::json!({ "error": "not_stored", "detail": problem.to_string(), "object_present": present }),
        );
    }

    let (bytes, chunks, largest_chunk, peak_memory, sha256) = {
        let seen = progress.borrow();
        (
            seen.bytes,
            seen.chunks,
            seen.largest_chunk,
            seen.peak_memory.max(memory_now()),
            hex::encode(seen.hash.clone().finalize()),
        )
    };
    if !sha256.eq_ignore_ascii_case(&expected) {
        bucket.delete(&key).await?;
        return answer(
            422,
            serde_json::json!({ "error": "hash_mismatch", "object_present": false }),
        );
    }

    env.queue("SCAN")?
        .send(&ScanJob {
            key: &key,
            id,
            kind: None,
        })
        .await?;
    let ms = Date::now().as_millis() - started;
    console_log!(
        "{}",
        serde_json::json!({ "at": "api", "id": id, "bytes": bytes, "ms": ms })
    );
    answer(
        200,
        serde_json::json!({ "id": id, "bytes": bytes, "sha256": sha256, "chunks": chunks, "largest_chunk": largest_chunk, "wasm_peak_bytes": peak_memory, "ms": ms }),
    )
}

#[event(fetch)]
async fn fetch(mut req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let url = req.url()?;
    let path: Vec<&str> = url
        .path_segments()
        .map(Iterator::collect)
        .unwrap_or_default();
    match (req.method(), path.as_slice()) {
        (Method::Put, ["objects", id]) if valid_id(id) => put_object(req, env, id).await,
        (Method::Post, ["probes", kind, id])
            if valid_id(id) && matches!(*kind, "probe" | "probe-update") =>
        {
            env.queue("SCAN")?
                .send(&ScanJob {
                    key: "",
                    id,
                    kind: Some(kind),
                })
                .await?;
            answer(200, serde_json::json!({ "queued": true }))
        }
        // For teardown, because wrangler can't list a bucket. It can only ever touch this spike's two prefixes.
        (Method::Post, ["cleanup"]) => {
            let bucket = env.bucket("ASSETS")?;
            let mut deleted = 0;
            for prefix in ["spike/", "results/"] {
                for object in bucket
                    .list()
                    .prefix(prefix)
                    .limit(200)
                    .execute()
                    .await?
                    .objects()
                {
                    bucket.delete(object.key()).await?;
                    deleted += 1;
                }
            }
            answer(200, serde_json::json!({ "deleted": deleted }))
        }
        (Method::Get, ["objects", id]) if valid_id(id) => {
            let found = env.bucket("ASSETS")?.head(format!("spike/{id}")).await?;
            answer(
                200,
                serde_json::json!({ "present": found.is_some(), "bytes": found.map(|object| object.size()) }),
            )
        }
        // Only the scanner's binding reaches this. The spike has no callers but itself.
        (Method::Post, ["results", id]) if valid_id(id) => {
            let body = req.text().await?;
            env.bucket("ASSETS")?
                .put(format!("results/{id}"), body)
                .execute()
                .await?;
            answer(200, serde_json::json!({ "recorded": true }))
        }
        (Method::Get, ["results", id]) if valid_id(id) => match env
            .bucket("ASSETS")?
            .get(format!("results/{id}"))
            .execute()
            .await?
        {
            Some(object) => {
                let text = object
                    .body()
                    .ok_or_else(|| Error::RustError("no body".into()))?
                    .text()
                    .await?;
                Response::from_json(&serde_json::from_str::<serde_json::Value>(&text)?)
            }
            None => answer(404, serde_json::json!({ "error": "no_result_yet" })),
        },
        _ => answer(404, serde_json::json!({ "error": "not_found" })),
    }
}
