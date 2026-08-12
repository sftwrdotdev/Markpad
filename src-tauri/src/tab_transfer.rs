use serde::Serialize;
use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

/// Maximum number of staged transfers kept in memory; oldest entries are
/// evicted first so an abandoned drag can never grow the map unbounded.
const MAX_PENDING_TRANSFERS: usize = 16;

/// How long a claimed-but-not-completed transfer is protected from the
/// source window's timeout. Beyond this the destination is assumed dead
/// (crashed or closed mid-render) and the source may reclaim its tab.
const CLAIM_GRACE: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct PendingTransfer {
    pub payload: String,
    pub source_label: String,
    pub target_label: Option<String>,
    /// Set the first time the destination window claims the payload. The
    /// broker uses it to tell "nobody picked this up" apart from "picked up,
    /// still rendering", which the source's timeout must not cancel.
    pub claimed_at: Option<Instant>,
}

/// Result of `cancel_detached_tab`. `cancelled == false && claimed == true`
/// means the destination already took the payload and is still finishing:
/// the source must keep waiting for `tab-transfer-claimed` instead of
/// restoring its tab.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CancelOutcome {
    pub cancelled: bool,
    pub claimed: bool,
}

/// Who is allowed to cancel a staged transfer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CancelAuthority {
    /// The window that staged the tab: cancels only while unclaimed.
    Source,
    /// The `window-<token>` or explicit target destination: releases its own claim (rollback).
    Destination,
    /// Any other window has no business touching this transfer.
    Forbidden,
}

#[derive(Default)]
struct BrokerInner {
    entries: HashMap<String, PendingTransfer>,
    insertion_order: Vec<String>,
}

impl BrokerInner {
    /// Which entry to drop once the cap is exceeded.
    ///
    /// A claimed entry is a transfer in flight: evicting it would strand the
    /// tab in both windows, so the oldest *unclaimed* entry goes first. The
    /// transfer that was just staged is never a candidate, and only when
    /// everything else is claimed does the oldest entry overall get dropped
    /// (the map still has to stay bounded).
    fn eviction_victim(&self) -> Option<String> {
        let candidates = self.insertion_order.split_last()?.1;
        candidates
            .iter()
            .find(|token| {
                self.entries
                    .get(*token)
                    .is_some_and(|entry| entry.claimed_at.is_none())
            })
            .or_else(|| candidates.first())
            .cloned()
    }
}

/// In-memory broker for moving a tab between windows: the source window
/// stages a JSON snapshot and hands the returned token to the new window,
/// which claims the payload exactly once.
pub struct TabTransferBroker {
    inner: Mutex<BrokerInner>,
    counter: AtomicU64,
}

/// Label of the window that a token authorises. `create_transfer_window`
/// in lib.rs builds the destination window with exactly this label, so a
/// webview cannot forge it: labels are assigned by the backend.
fn destination_label(token: &str) -> String {
    format!("window-{token}")
}

fn is_destination_label(caller_label: &str, token: &str) -> bool {
    caller_label == destination_label(token)
}

fn is_destination_authority(caller_label: &str, token: &str, target_label: Option<&str>) -> bool {
    is_destination_label(caller_label, token) || target_label == Some(caller_label)
}

fn cancel_authority(
    caller_label: &str,
    source_label: &str,
    token: &str,
    target_label: Option<&str>,
) -> CancelAuthority {
    if caller_label == source_label {
        CancelAuthority::Source
    } else if is_destination_authority(caller_label, token, target_label) {
        CancelAuthority::Destination
    } else {
        CancelAuthority::Forbidden
    }
}

/// 64 unpredictable bits. `RandomState` is seeded once per process from the
/// OS, and the sequence number plus the timestamp and a stack address keep
/// successive tokens from being derivable from one another. A webview can
/// observe neither the seed nor the addresses, so tokens are not guessable
/// the way the old `t1`..`t16` counter was.
fn random_bits(seq: u64, round: u64) -> u64 {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(seq);
    hasher.write_u64(round);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    hasher.write_u128(nanos);
    let probe = 0u8;
    hasher.write_usize(std::ptr::addr_of!(probe) as usize);
    hasher.finish()
}

impl TabTransferBroker {
    pub fn new() -> Self {
        TabTransferBroker {
            inner: Mutex::new(BrokerInner::default()),
            counter: AtomicU64::new(0),
        }
    }

    fn next_token(&self) -> String {
        let seq = self.counter.fetch_add(1, Ordering::Relaxed);
        format!("{:016x}{:016x}", random_bits(seq, 0), random_bits(seq, 1))
    }

    fn stage(&self, payload: String, source_label: String) -> String {
        let token = self.next_token();
        let mut inner = crate::window_runtime::lock_recover(&self.inner);
        inner.entries.insert(
            token.clone(),
            PendingTransfer {
                payload,
                source_label,
                target_label: None,
                claimed_at: None,
            },
        );
        inner.insertion_order.push(token.clone());
        while inner.entries.len() > MAX_PENDING_TRANSFERS {
            let Some(victim) = inner.eviction_victim() else {
                break;
            };
            inner.insertion_order.retain(|entry| entry != &victim);
            inner.entries.remove(&victim);
        }
        token
    }

    pub fn set_target_label(&self, token: &str, target_label: String) -> Result<(), String> {
        let mut inner = crate::window_runtime::lock_recover(&self.inner);
        let entry = inner
            .entries
            .get_mut(token)
            .ok_or_else(|| "TRANSFER_NOT_FOUND".to_string())?;
        entry.target_label = Some(target_label);
        Ok(())
    }

    /// Reserves the payload for the destination window without removing it:
    /// the source keeps its tab until `complete` confirms the hand-off. The
    /// first claim stamps the entry so the source's timeout can tell a dead
    /// transfer from one that is merely still rendering.
    fn claim(&self, token: &str, now: Instant) -> Option<PendingTransfer> {
        let mut inner = crate::window_runtime::lock_recover(&self.inner);
        let entry = inner.entries.get_mut(token)?;
        if entry.claimed_at.is_none() {
            entry.claimed_at = Some(now);
        }
        Some(entry.clone())
    }

    fn peek(&self, token: &str) -> Option<PendingTransfer> {
        crate::window_runtime::lock_recover(&self.inner)
            .entries
            .get(token)
            .cloned()
    }

    fn take(&self, token: &str) -> Option<PendingTransfer> {
        let mut inner = crate::window_runtime::lock_recover(&self.inner);
        inner.insertion_order.retain(|entry| entry != token);
        inner.entries.remove(token)
    }

    /// The source's own timeout path: never destroys a transfer the
    /// destination has already claimed and is still working on.
    fn cancel_from_source(&self, token: &str, now: Instant) -> CancelOutcome {
        let claimed_at = match self.peek(token) {
            Some(entry) => entry.claimed_at,
            None => {
                return CancelOutcome {
                    cancelled: false,
                    claimed: false,
                }
            }
        };
        if let Some(claimed_at) = claimed_at {
            if now.duration_since(claimed_at) < CLAIM_GRACE {
                return CancelOutcome {
                    cancelled: false,
                    claimed: true,
                };
            }
        }
        self.take(token);
        CancelOutcome {
            cancelled: true,
            claimed: claimed_at.is_some(),
        }
    }

    /// The destination's rollback path: it owns the claim, so it may always
    /// release it (render failed, window closing).
    fn cancel_from_destination(&self, token: &str) -> CancelOutcome {
        match self.take(token) {
            Some(entry) => CancelOutcome {
                cancelled: true,
                claimed: entry.claimed_at.is_some(),
            },
            None => CancelOutcome {
                cancelled: false,
                claimed: false,
            },
        }
    }

    /// The gate in front of `claim` and `complete`. A window is a destination
    /// if the token names it (`create_transfer_window` built it) or if
    /// `offer_tab_to_window` recorded it as the target; an unknown token has
    /// no destination at all, so it is refused here rather than later.
    fn authorize_destination(
        &self,
        caller_label: &str,
        token: &str,
        action: &str,
    ) -> Result<(), String> {
        let authorized = self.peek(token).is_some_and(|entry| {
            is_destination_authority(caller_label, token, entry.target_label.as_deref())
        });
        if authorized {
            Ok(())
        } else {
            Err(format!(
                "TRANSFER_FORBIDDEN: window '{caller_label}' may not {action} this tab transfer"
            ))
        }
    }

    fn claim_as(
        &self,
        caller_label: &str,
        token: &str,
        now: Instant,
    ) -> Result<Option<String>, String> {
        self.authorize_destination(caller_label, token, "claim")?;
        Ok(self.claim(token, now).map(|transfer| transfer.payload))
    }

    fn complete_as(&self, caller_label: &str, token: &str) -> Result<PendingTransfer, String> {
        self.authorize_destination(caller_label, token, "complete")?;
        self.take(token).ok_or_else(|| {
            "TRANSFER_NOT_FOUND: the staged tab is gone; the source window kept it".to_string()
        })
    }

    fn cancel_as(
        &self,
        caller_label: &str,
        token: &str,
        now: Instant,
    ) -> Result<CancelOutcome, String> {
        let Some(entry) = self.peek(token) else {
            // Already completed, cancelled or never staged: cancelling is a
            // no-op, so stay idempotent rather than erroring on a late timeout.
            return Ok(CancelOutcome {
                cancelled: false,
                claimed: false,
            });
        };
        match cancel_authority(
            caller_label,
            &entry.source_label,
            token,
            entry.target_label.as_deref(),
        ) {
            CancelAuthority::Source => Ok(self.cancel_from_source(token, now)),
            CancelAuthority::Destination => Ok(self.cancel_from_destination(token)),
            CancelAuthority::Forbidden => Err(format!(
                "TRANSFER_FORBIDDEN: window '{caller_label}' may not cancel this tab transfer"
            )),
        }
    }
}

#[tauri::command]
pub fn stage_detached_tab(
    window: tauri::Window,
    state: State<'_, TabTransferBroker>,
    payload: String,
) -> String {
    state.stage(payload, window.label().to_string())
}

#[tauri::command]
pub fn claim_detached_tab(
    window: tauri::Window,
    state: State<'_, TabTransferBroker>,
    token: String,
) -> Result<Option<String>, String> {
    state.claim_as(window.label(), &token, Instant::now())
}

#[tauri::command]
pub fn complete_detached_tab(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, TabTransferBroker>,
    token: String,
) -> Result<(), String> {
    let transfer = state.complete_as(window.label(), &token)?;
    app.emit_to(
        transfer.source_label.as_str(),
        "tab-transfer-claimed",
        token,
    )
    .map_err(|e| format!("TRANSFER_HANDOFF_FAILED: {e}"))
}

#[tauri::command]
pub fn cancel_detached_tab(
    window: tauri::Window,
    state: State<'_, TabTransferBroker>,
    token: String,
) -> Result<CancelOutcome, String> {
    state.cancel_as(window.label(), &token, Instant::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ago(seconds: u64) -> Instant {
        Instant::now()
            .checked_sub(Duration::from_secs(seconds))
            .expect("test clock should not underflow")
    }

    #[test]
    fn stage_claim_then_complete_removes_entry() {
        let broker = TabTransferBroker::new();
        let token = broker.stage("{\"tab\":1}".to_string(), "main".to_string());

        let transfer = broker
            .claim(&token, Instant::now())
            .expect("staged transfer should exist");
        assert_eq!(transfer.payload, "{\"tab\":1}");
        assert_eq!(transfer.source_label, "main");

        // Claim is a non-destructive reservation read: the source stays intact
        // until the destination has completed validation and rendering.
        assert!(broker.peek(&token).is_some());
        assert!(broker.take(&token).is_some());
        assert!(broker.peek(&token).is_none());
    }

    #[test]
    fn cancel_then_claim_returns_none() {
        let broker = TabTransferBroker::new();
        let token = broker.stage("{}".to_string(), "window-1".to_string());

        broker.cancel_from_source(&token, Instant::now());
        assert!(broker.claim(&token, Instant::now()).is_none());
    }

    #[test]
    fn tokens_are_unique_across_stages() {
        let broker = TabTransferBroker::new();
        let first = broker.stage("a".to_string(), "main".to_string());
        let second = broker.stage("b".to_string(), "main".to_string());
        assert_ne!(first, second);
    }

    // P1-B-4: the old `t{counter}` scheme let any webview walk t1..t16 and
    // read another window's document.
    #[test]
    fn tokens_are_not_enumerable() {
        let broker = TabTransferBroker::new();
        let mut seen = Vec::new();
        for _ in 0..64 {
            let token = broker.stage("payload".to_string(), "main".to_string());
            assert_eq!(token.len(), 32, "token should carry 128 bits of hex");
            assert!(
                token.chars().all(|c| c.is_ascii_hexdigit()),
                "token must stay label-safe: {token}"
            );
            assert!(!seen.contains(&token), "tokens must not repeat");
            seen.push(token);
        }
        // No sequential relationship between successive tokens.
        assert!(seen
            .windows(2)
            .all(|pair| pair[0].as_bytes()[..8] != pair[1].as_bytes()[..8]));
    }

    #[test]
    fn only_the_matching_destination_window_may_claim() {
        assert!(is_destination_authority("window-abc", "abc", None));
        assert!(!is_destination_authority("main", "abc", None));
        assert!(is_destination_authority("main", "abc", Some("main")));
        assert!(!is_destination_authority("other", "abc", Some("main")));
        assert!(!is_destination_authority("window-abcd", "abc", None));
        assert!(!is_destination_authority("window-abc", "abcd", None));
    }

    #[test]
    fn cancel_authority_rejects_third_party_windows() {
        assert_eq!(
            cancel_authority("main", "main", "abc", None),
            CancelAuthority::Source
        );
        assert_eq!(
            cancel_authority("window-abc", "main", "abc", None),
            CancelAuthority::Destination
        );
        assert_eq!(
            cancel_authority("other", "main", "abc", Some("other")),
            CancelAuthority::Destination
        );
        // The window of some *other* transfer must not be able to tear this
        // one down.
        assert_eq!(
            cancel_authority("window-zzz", "main", "abc", None),
            CancelAuthority::Forbidden
        );
        assert_eq!(
            cancel_authority("window-7", "window-9", "abc", None),
            CancelAuthority::Forbidden
        );
    }

    // P1-B-3: claiming marks the entry so the source's 15s timeout stops
    // racing a slow but healthy destination.
    #[test]
    fn claim_marks_the_entry_and_repeated_claims_keep_the_first_stamp() {
        let broker = TabTransferBroker::new();
        let token = broker.stage("doc".to_string(), "main".to_string());
        assert!(broker.peek(&token).unwrap().claimed_at.is_none());

        let first_at = ago(5);
        assert!(broker.claim(&token, first_at).is_some());
        assert_eq!(broker.peek(&token).unwrap().claimed_at, Some(first_at));

        // A retried claim (destination re-reading after a reload) is allowed
        // and must not restart the grace period.
        let second = broker
            .claim(&token, Instant::now())
            .expect("repeat claim should still return the payload");
        assert_eq!(second.payload, "doc");
        assert_eq!(broker.peek(&token).unwrap().claimed_at, Some(first_at));
    }

    #[test]
    fn source_timeout_does_not_cancel_a_claimed_transfer() {
        let broker = TabTransferBroker::new();
        let token = broker.stage("doc".to_string(), "main".to_string());
        broker.claim(&token, Instant::now());

        let outcome = broker.cancel_from_source(&token, Instant::now());
        assert_eq!(
            outcome,
            CancelOutcome {
                cancelled: false,
                claimed: true
            }
        );
        assert!(
            broker.peek(&token).is_some(),
            "the destination is still rendering; the entry must survive"
        );
    }

    #[test]
    fn source_timeout_cancels_an_unclaimed_transfer() {
        let broker = TabTransferBroker::new();
        let token = broker.stage("doc".to_string(), "main".to_string());

        let outcome = broker.cancel_from_source(&token, Instant::now());
        assert_eq!(
            outcome,
            CancelOutcome {
                cancelled: true,
                claimed: false
            }
        );
        assert!(broker.peek(&token).is_none());
    }

    #[test]
    fn source_may_reclaim_after_the_claim_grace_expires() {
        let broker = TabTransferBroker::new();
        let token = broker.stage("doc".to_string(), "main".to_string());
        broker.claim(&token, ago(CLAIM_GRACE.as_secs() + 30));

        let outcome = broker.cancel_from_source(&token, Instant::now());
        assert_eq!(
            outcome,
            CancelOutcome {
                cancelled: true,
                claimed: true
            }
        );
        assert!(broker.peek(&token).is_none());
    }

    #[test]
    fn destination_may_release_its_own_claim() {
        let broker = TabTransferBroker::new();
        let token = broker.stage("doc".to_string(), "main".to_string());
        broker.claim(&token, Instant::now());

        let outcome = broker.cancel_from_destination(&token);
        assert_eq!(
            outcome,
            CancelOutcome {
                cancelled: true,
                claimed: true
            }
        );
        assert!(broker.peek(&token).is_none());
    }

    #[test]
    fn cancelling_an_unknown_token_is_a_no_op() {
        let broker = TabTransferBroker::new();
        let missing = CancelOutcome {
            cancelled: false,
            claimed: false,
        };
        assert_eq!(broker.cancel_from_source("nope", Instant::now()), missing);
        assert_eq!(broker.cancel_from_destination("nope"), missing);
    }

    // P1-B-2: completing a transfer whose entry is gone must be reported,
    // not silently swallowed, so the destination can roll its tab back.
    #[test]
    fn completing_twice_finds_nothing_the_second_time() {
        let broker = TabTransferBroker::new();
        let token = broker.stage("doc".to_string(), "main".to_string());
        broker.claim(&token, Instant::now());

        assert!(broker.take(&token).is_some());
        assert!(
            broker.take(&token).is_none(),
            "second completion must surface as an error to the caller"
        );
    }

    #[test]
    fn staging_beyond_cap_evicts_oldest() {
        let broker = TabTransferBroker::new();
        let mut tokens = Vec::new();
        for i in 0..=MAX_PENDING_TRANSFERS {
            tokens.push(broker.stage(format!("payload-{}", i), "main".to_string()));
        }

        // The very first entry was evicted; every later one is still claimable.
        assert!(broker.peek(&tokens[0]).is_none());
        for (i, token) in tokens.iter().enumerate().skip(1) {
            let transfer = broker.peek(token).expect("entry within cap should remain");
            assert_eq!(transfer.payload, format!("payload-{}", i));
        }
    }

    #[test]
    fn eviction_skips_claimed_transfers() {
        let broker = TabTransferBroker::new();
        let in_flight = broker.stage("in-flight".to_string(), "main".to_string());
        broker.claim(&in_flight, Instant::now());
        let second = broker.stage("second".to_string(), "main".to_string());

        for i in 0..MAX_PENDING_TRANSFERS {
            broker.stage(format!("filler-{}", i), "main".to_string());
        }

        assert!(
            broker.peek(&in_flight).is_some(),
            "a claimed transfer is in flight and must not be evicted"
        );
        assert!(
            broker.peek(&second).is_none(),
            "the oldest unclaimed entry is the one that gets evicted"
        );
    }

    #[test]
    fn eviction_falls_back_to_the_oldest_when_everything_is_claimed() {
        let broker = TabTransferBroker::new();
        let mut tokens = Vec::new();
        for i in 0..=MAX_PENDING_TRANSFERS {
            let token = broker.stage(format!("payload-{}", i), "main".to_string());
            broker.claim(&token, Instant::now());
            tokens.push(token);
        }

        // Memory stays bounded even in the pathological all-claimed case.
        assert!(broker.peek(&tokens[0]).is_none());
        assert!(broker.peek(&tokens[MAX_PENDING_TRANSFERS]).is_some());
    }

    // The tests above take the broker and the authorisation predicates apart.
    // These four put them back together and run a transfer from `stage` to
    // `complete`, because the defect #452 fixed was in the composition: the
    // gate matched the predicate it was written against, the broker held the
    // payload it was asked to hold, and the path between them was closed.

    /// A window that already exists when the transfer starts. Either `main`
    /// or, as here, a window some earlier transfer created — so its label
    /// derives from a *different* token. `window-<token>` for the token being
    /// transferred is the one label such a window can never have.
    const EXISTING_WINDOW: &str = "window-1f0e9d8c7b6a5948372615043f2e1d0c";

    // Move to Window > (an open window). `offer_tab_to_window` records the
    // target before it notifies it; without that record the destination is
    // not `window-<token>` and every step below is TRANSFER_FORBIDDEN.
    #[test]
    fn a_transfer_to_an_existing_window_runs_end_to_end() {
        let broker = TabTransferBroker::new();
        let token = broker.stage("{\"tab\":\"notes.md\"}".to_string(), "main".to_string());
        broker
            .set_target_label(&token, EXISTING_WINDOW.to_string())
            .expect("a staged transfer should accept the target it is offered to");

        let payload = broker
            .claim_as(EXISTING_WINDOW, &token, Instant::now())
            .expect("the window offer_tab_to_window named is a destination and may claim")
            .expect("the staged payload should still be there");
        assert_eq!(payload, "{\"tab\":\"notes.md\"}");

        let transfer = broker
            .complete_as(EXISTING_WINDOW, &token)
            .expect("the window that claimed the payload must be able to complete the hand-off");
        assert_eq!(
            transfer.source_label, "main",
            "completion names the source so it is the window told to drop its tab"
        );
        assert!(
            broker.peek(&token).is_none(),
            "a completed transfer must leave nothing behind for a second claim"
        );
    }

    // Move to New Window. `create_transfer_window` builds `window-<token>`
    // and nothing records a target, so this path must keep working off the
    // derived label alone.
    #[test]
    fn a_transfer_to_a_new_window_runs_end_to_end() {
        let broker = TabTransferBroker::new();
        let token = broker.stage("{\"tab\":\"draft.md\"}".to_string(), "main".to_string());
        let destination = destination_label(&token);

        let payload = broker
            .claim_as(&destination, &token, Instant::now())
            .expect("the window the token names is a destination and may claim")
            .expect("the staged payload should still be there");
        assert_eq!(payload, "{\"tab\":\"draft.md\"}");

        let transfer = broker
            .complete_as(&destination, &token)
            .expect("the window the token names must be able to complete the hand-off");
        assert_eq!(transfer.source_label, "main");
        assert!(broker.peek(&token).is_none());
    }

    // Widening the gate to the recorded target must not widen it to everyone:
    // the payload is a document the source window had open.
    #[test]
    fn a_third_party_window_is_refused_at_every_step() {
        const BYSTANDER: &str = "window-00000000000000000000000000000000";

        let broker = TabTransferBroker::new();
        let token = broker.stage("{\"tab\":\"private.md\"}".to_string(), "main".to_string());
        broker
            .set_target_label(&token, EXISTING_WINDOW.to_string())
            .expect("a staged transfer should accept the target it is offered to");

        for refusal in [
            broker.claim_as(BYSTANDER, &token, Instant::now()).err(),
            broker.complete_as(BYSTANDER, &token).err(),
            broker.cancel_as(BYSTANDER, &token, Instant::now()).err(),
        ] {
            let message = refusal.expect(
                "neither the source, nor window-<token>, nor the recorded target: refuse it",
            );
            assert!(message.starts_with("TRANSFER_FORBIDDEN"), "{message}");
        }

        // The refusals are inert: the transfer is untouched and its actual
        // destination can still take it.
        assert_eq!(
            broker
                .claim_as(EXISTING_WINDOW, &token, Instant::now())
                .expect("the real destination must not be affected by the refusals")
                .as_deref(),
            Some("{\"tab\":\"private.md\"}")
        );
    }

    // A claim makes the source's timeout a no-op, so the window holding it is
    // the only party that can end it. If the recorded target were refused
    // here, a failed render would strand the tab in both windows.
    #[test]
    fn the_recorded_destination_may_release_its_own_claim() {
        let broker = TabTransferBroker::new();
        let token = broker.stage("{\"tab\":\"notes.md\"}".to_string(), "main".to_string());
        broker
            .set_target_label(&token, EXISTING_WINDOW.to_string())
            .expect("a staged transfer should accept the target it is offered to");
        broker
            .claim_as(EXISTING_WINDOW, &token, Instant::now())
            .expect("the recorded target may claim");

        let outcome = broker
            .cancel_as(EXISTING_WINDOW, &token, Instant::now())
            .expect("the window holding the claim must be able to release it");
        assert_eq!(
            outcome,
            CancelOutcome {
                cancelled: true,
                claimed: true
            }
        );
        assert!(
            broker.peek(&token).is_none(),
            "a released claim must free the transfer, not leave it claimed forever"
        );
    }
}
