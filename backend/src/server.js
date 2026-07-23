require('dotenv').config();

const express = require('express');
const cors = require('cors');

const authRouter = require('./routes/auth');
const farmerRouter = require('./routes/farmer');
const lenderRouter = require('./routes/lender');
const buyerRouter = require('./routes/buyer');

const app = express();

app.use(cors());
app.use(express.json());

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
app.use('/lender', lenderRouter);
app.use('/buyer', buyerRouter);

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
