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
app.use('/lender', lenderRouter);
app.use('/buyer', buyerRouter);
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
