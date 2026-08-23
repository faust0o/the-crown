pub mod add_entry;
pub mod authorize_relayer;
pub mod close_bet;
pub mod close_round;
pub mod initialize;
pub mod open_round;
pub mod place_bet;
pub mod record_cut;
pub mod reveal_seed;
pub mod settle_bet;

// Glob re-exports, because `#[program]` resolves the `__client_accounts_*`
// modules it generates through the crate root and they are not nameable here.
//
// Each module's entry point is therefore named after its instruction rather than
// `handler`: eight modules re-exporting ten different `handler`s into one namespace
// is an ambiguous glob re-export, which Rust warns about today and resolves
// arbitrarily. Unique names make the collision impossible instead of merely
// unlikely, and read better at the call site in `lib.rs`.
pub use add_entry::*;
pub use authorize_relayer::*;
pub use close_bet::*;
pub use close_round::*;
pub use initialize::*;
pub use open_round::*;
pub use place_bet::*;
pub use record_cut::*;
pub use reveal_seed::*;
pub use settle_bet::*;
