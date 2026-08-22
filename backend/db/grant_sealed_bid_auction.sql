-- ============================================================
-- Sealed-Bid e-Auction mode
-- ============================================================
-- Builds on grant_b2b_commerce_engine.sql's e-Auction (procurement.auction /
-- procurement.auction_bid). That existing auction is documented (see
-- B2B_COMMERCE_ENGINE_ARCHITECTURE.md section 4.4) as "sealed-bid-lite":
-- bidder IDENTITY is hidden from other bidders while the auction runs, but
-- the running current_lowest_bid / bid_count is fully visible live to
-- everyone, and a new bid is rejected outright unless it strictly beats the
-- current global lowest.
--
-- This migration adds a second, genuinely-sealed mode alongside it, chosen
-- per-auction at creation time via a new `bid_visibility` column:
--
--   'live'   (default) — unchanged existing behaviour described above.
--             Every auction created before this migration, and every
--             auction created after it without an explicit mode, keeps
--             working exactly as it does today. This migration is purely
--             additive: it changes nothing about already-shipped behaviour.
--
--   'sealed' (new) — true sealed-bid. While the auction is `open`:
--               * NO price is ever exposed to anyone — not the bidders,
--                 not spectators, and not even the requester who created
--                 the auction (matching how a real sealed-bid tender works:
--                 nobody, including the buyer running it, can see bids
--                 mid-auction, which is what stops the buyer from tipping
--                 off a favoured bidder). `current_lowest_bid`/
--                 `my_lowest_bid` are simply omitted from every response
--                 for a sealed+open auction.
--               * A bidder may resubmit as many times as they like before
--                 `closes_at`, at any positive price — there is no "must
--                 beat the current lowest" rejection like the 'live' mode
--                 has, because a bidder who cannot see the current lowest
--                 has nothing to beat against; rejecting a bid would also
--                 leak information (a reject == "you weren't competitive").
--               * Every submission gets an immediate `is_leading` boolean
--                 in the response — true if that bidder's org is the one
--                 that would win if the auction closed right now, false
--                 otherwise. This is computed with the exact same
--                 `ORDER BY bid_price ASC, submitted_at ASC` tiebreak that
--                 closeAndAwardAuction() already uses to pick the winner
--                 (see procurement.js), so the live indicator can never
--                 disagree with the eventual auto-award outcome.
--             Once the auction closes/is awarded, prices are revealed the
--             same way they already are for 'live' auctions: through the
--             existing requester-only `GET /auctions/:id/bids` full bid
--             history endpoint (bidder identity + price, unchanged by this
--             migration) and `current_lowest_bid` reappearing in the
--             summary/detail endpoints once `status != 'open'`. This
--             mirrors the reveal-only-after-award pattern already used for
--             direct RFQ quotes elsewhere in this file — no new endpoint
--             was needed for it.
--
-- No new GRANTs are needed: agrolink_app already holds table-level
-- SELECT/INSERT/UPDATE on procurement.auction (see grant_b2b_commerce_
-- engine.sql), which covers this new column automatically.
-- ============================================================

ALTER TABLE procurement.auction
  ADD COLUMN IF NOT EXISTS bid_visibility text NOT NULL DEFAULT 'live'
    CHECK (bid_visibility IN ('live', 'sealed'));

COMMENT ON COLUMN procurement.auction.bid_visibility IS
  'live = existing sealed-bid-lite (identity hidden, price visible live, a bid must strictly beat the current lowest to be accepted). sealed = true sealed-bid (no price ever shown to anyone, including the requester, while open; unlimited resubmission at any price; only an is_leading boolean is returned per submission). Default ''live'' preserves all pre-existing auctions'' behaviour unchanged.';
