/*
 * Unit tests for the milk-centre gateway intake rules in src/lib/dairyIot.js (no database):
 * event validation (id, type, channel, time window), analyzer values and quality warnings.
 * Run with: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/lib/dairyIot');

const NOW = new Date('2026-11-24T01:00:00Z'); // 08:00 น. เวลาไทย
const ev = (x) => ({ id: 'evt_0001abcd', type: 'intake', channel: 'scale1', at: '2026-11-24T00:30:00Z', ...x });
const code = (fn) => { try { fn(); } catch (e) { return e.body && e.body.error; } return null; };

test('parseEvent: id, type, channel and the time window', () => {
  const p = G.parseEvent(ev(), NOW);
  assert.equal(p.type, 'intake');
  assert.equal(p.at.toISOString(), '2026-11-24T00:30:00.000Z');
  assert.equal(code(() => G.parseEvent(ev({ id: 'short' }), NOW)), 'invalid_event_id');
  assert.equal(code(() => G.parseEvent(ev({ id: 'bad id with spaces!' }), NOW)), 'invalid_event_id');
  assert.equal(code(() => G.parseEvent(ev({ type: 'delete' }), NOW)), 'invalid_event_type');
  assert.equal(code(() => G.parseEvent(ev({ channel: 'Scale 1' }), NOW)), 'invalid_channel');
  assert.equal(code(() => G.parseEvent(ev({ at: 'yesterday' }), NOW)), 'invalid_event_time');
  // gateway clock ahead by more than 5 minutes → refuse (would land in the wrong round)
  assert.equal(code(() => G.parseEvent(ev({ at: '2026-11-24T01:06:00Z' }), NOW)), 'event_time_in_future');
  assert.equal(G.parseEvent(ev({ at: '2026-11-24T01:04:00Z' }), NOW).type, 'intake');
  // buffered for more than 7 days (or a gateway that booted with a 1970 clock)
  assert.equal(code(() => G.parseEvent(ev({ at: '2026-11-16T00:00:00Z' }), NOW)), 'event_too_old');
  assert.equal(code(() => G.parseEvent(ev({ at: '1970-01-01T00:00:10Z' }), NOW)), 'event_too_old');
  // heartbeat needs no channel
  assert.equal(G.parseEvent({ id: 'hb_00000001', type: 'heartbeat', at: NOW.toISOString() }, NOW).channel, null);
});

test('bkkDay: a 23:30 UTC sample belongs to the next Thai day', () => {
  assert.equal(G.bkkDay(new Date('2026-11-23T23:30:00Z')), '2026-11-24');
  assert.equal(G.bkkDay(new Date('2026-11-23T16:59:00Z')), '2026-11-23');
});

test('analysisValues + qualityWarning', () => {
  const v = G.analysisValues({ fat_pct: 3.9, snf_pct: '8.45', density: 1029.5, added_water_pct: 0, freezing_point_c: -0.535 });
  assert.equal(v.fat_pct, 3.9);
  assert.equal(v.snf_pct, 8.45);
  assert.equal(v.protein_pct, null);
  assert.equal(G.qualityWarning(v), null);
  assert.equal(code(() => G.analysisValues({ fat_pct: 35 })), 'invalid_field');
  assert.equal(code(() => G.analysisValues({ milk_temp_c: 4 })), 'empty_analysis');
  assert.match(G.qualityWarning({ added_water_pct: 4.5, freezing_point_c: -0.48 }), /น้ำปน 4.5%.*จุดเยือกแข็ง -0.48/);
  assert.equal(G.qualityWarning({ added_water_pct: 1.9, freezing_point_c: -0.52 }), null);
});
