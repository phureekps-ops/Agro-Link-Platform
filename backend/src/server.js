require('dotenv').config();

const express = require('express');
const cors = require('cors');

const authRouter = require('./routes/auth');
const farmerRouter = require('./routes/farmer');
const lenderRouter = require('./routes/lender');
const buyerRouter = require('./routes/buyer');
const adminRouter = require('./routes/admin');
const machineryRouter = require('./routes/machinery');
const organizationRouter = require('./routes/organization');
const inputSupplierRouter = require('./routes/inputsupplier');
const marketVenueRouter = require('./routes/marketvenue');
const contentRouter = require('./routes/content');
const stageCalendarRouter = require('./routes/stagecalendar');
const fertilizerRouter = require('./routes/fertilizer');
const fertilizerMixingRouter = require('./routes/fertilizermixing');
const carbonRouter = require('./routes/carbon');
const farmerMachineryRouter = require('./routes/farmermachinery');
const farmerVenueRouter = require('./routes/farmervenue');
const coopCollectionRouter = require('./routes/coopcollection');
const governmentRouter = require('./routes/government');
const storageRouter = require('./routes/storage');
// procurement.js — RFQ/RFP (Request for Proposal / Request for Quote)
// cross-portal marketplace (see backend/db/grant_rfq_marketplace.sql).
// Subject-type agnostic (both farmer and organization JWTs are accepted
// on the same endpoints, gated per-handler), so its own prefix rather
// than sharing any one portal's mount.
const procurementRouter = require('./routes/procurement');
// groupbuy.js — Group Buy (รวมออเดอร์ประมูลร่วมของสหกรณ์, see
// GROUP_BUY_ARCHITECTURE.md). Shares the '/procurement' prefix with
// procurement.js above (same "more than one router on one prefix" idiom
// fertilizer.js uses with farmer.js on '/farmer') rather than growing
// procurement.js further or inventing a separate prefix for what is
// really just a collection layer in front of the same RFQ/Auction tables.
const groupBuyRouter = require('./routes/groupbuy');
// farmer360.js — Farmer 360° View (see FARMER_360_ARCHITECTURE.md).
// Generic across ANY verified organization (same "own prefix, not
// portal-scoped" reasoning as procurement.js above) — used by the
// Cooperative, Lender, and VillageFund portals in this pass.
const farmer360Router = require('./routes/farmer360');
const villageFundRouter = require('./routes/villagefund');
// logistics.js — Logistics org self-service portal (see
// grant_logistics_portal.sql). A brand new org-facing portal for a
// self-registered org_type='Logistics' trucking company to see/act on
// shipments a cooperative has linked its carrier record to — its own
// prefix, distinct from '/coop' (coopcollection.js), which is the
// cooperative's own side of the exact same logistics.* schema.
const logisticsRouter = require('./routes/logistics');

// aquaculture.js — Auction Place: shrimp sealed-bid forward auction (see
// SHRIMP_AUCTION_ARCHITECTURE.md). Subject-type agnostic (farmer pond
// owners open/manage auctions, organization Buyers bid), same reasoning as
// procurement.js above — its own prefix, not scoped to one portal.
const aquacultureRouter = require('./routes/aquaculture');

const app = express();

app.use(cors());
// Default express.json() body limit is 100kb — too small for
// POST /machinery/photos, which posts a base64 data: URL (no object
// storage/CDN exists in this sandbox, see grant_machinery_marketplace.sql).
// 5mb comfortably covers that route's own ~3MB payload cap without opening
// the door to arbitrarily large request bodies elsewhere.
app.use(express.json({ limit: '5mb' }));

// Simple request log — helps when eyeballing the RLS-isolation tests later.
app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.path}`);
  next();
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'agrolink-farmer-portal-api' });
});

app.use('/auth', authRouter);
app.use('/farmer', farmerRouter);
// stagecalendar.js (crop-cycle/stage endpoints) and fertilizer.js (soil
// test, fertilizer-formula calculator, and fertilizer-mixing-order
// endpoints) are BOTH additional farmer-facing route files sharing the
// same /farmer prefix as farmerRouter above — Express dispatches by exact
// path match across all three in registration order, and none of their
// route paths collide (verified: no two of farmer.js/stagecalendar.js/
// fertilizer.js define the same sub-path), so mounting all three at
// '/farmer' is safe and is what frontend/js/crop-cycle.js,
// frontend/js/fertilizer-calculator.js, and
// frontend/js/fertilizer-mixing-marketplace.js all already assume.
app.use('/farmer', stageCalendarRouter);
app.use('/farmer', fertilizerRouter);
// carbon.js (AWD water-log + carbon-credit-estimate endpoints, all under
// /farmer/carbon/*) — same shared-'/farmer'-prefix pattern as above; no
// path collision with farmer.js/stagecalendar.js/fertilizer.js (none of
// them use a /carbon/* sub-path).
app.use('/farmer', carbonRouter);
// farmermachinery.js (machinery/drying-yard service booking — browse
// providers, book, view own bookings, cancel) — same shared '/farmer'
// prefix pattern as above; no path collision with the other four farmer
// route files (none of them define a /machinery-* sub-path).
app.use('/farmer', farmerMachineryRouter);
// farmervenue.js — farmer-facing "หาที่ขายสินค้า" browsing/booking routes,
// restored after being accidentally deleted with no replacement in commit
// 6be68c3 (see that file's own header comment). Same shared '/farmer'
// prefix pattern as farmermachinery.js above; no path collision (no other
// farmer route file defines a /venue-* sub-path).
app.use('/farmer', farmerVenueRouter);
app.use('/lender', lenderRouter);
app.use('/buyer', buyerRouter);
// coopcollection.js — M09 Collection & Quality station for cooperatives
// (identity.organization_role.role_type = 'Cooperative'). Mounted at its
// own '/coop' prefix rather than sharing '/buyer' — a cooperative's
// portal is conceptually distinct even though it reuses the same
// produce.delivery machinery under the hood (see the route file's own
// doc comment).
app.use('/coop', coopCollectionRouter);
// government.js — Provincial/National government officer portal
// (identity.government_officer, see grant_staff_and_government_access.
// sql). A brand new subject type, so its own prefix rather than sharing
// '/admin' (Platform Ops) — a government officer is explicitly NOT
// Platform Ops, just as a Cooperative is not a private Buyer.
app.use('/gov', governmentRouter);
// storage.js — generic object storage upload/download (M01, see
// backend/db/grant_object_storage.sql). Its own prefix since it is
// subject-type agnostic and not owned by any one portal.
app.use('/storage', storageRouter);
app.use('/procurement', procurementRouter);
app.use('/procurement', groupBuyRouter);
app.use('/farmer360', farmer360Router);
app.use('/villagefund', villageFundRouter);
app.use('/logistics', logisticsRouter);
app.use('/aquaculture', aquacultureRouter);
app.use('/admin', adminRouter);
app.use('/machinery', machineryRouter);
app.use('/marketvenue', marketVenueRouter);
app.use('/fertilizermixing', fertilizerMixingRouter);
app.use('/organization', organizationRouter);
app.use('/inputsupplier', inputSupplierRouter);
// GET /about — public, no auth (see content.js's own doc comment).
app.use('/about', contentRouter);

// Fallback 404
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
});

// Central error handler — keeps stack traces out of API responses.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[http] unhandled error', err);
  const status = err.status || 500;
  res.status(status).json({ error: err.publicMessage || 'internal_error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`[server] AgroLink Farmer Portal API listening on port ${PORT}`);
});

module.exports = app;
