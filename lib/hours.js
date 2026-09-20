// lib/hours.js — per-tenant business hours.
//
// Why this exists: the old isBusinessHours() read BUSINESS_HOURS_START,
// BUSINESS_HOURS_END and BUSINESS_TIMEZONE from the environment, which are
// process-wide. Every tenant on the platform therefore answered with First
// Financial's Alberta hours — Hunt Chrysler is in Ontario, so their customers
// were told the wrong hours in the wrong time zone. Same family of bug as the
// notifyPhone leak: one tenant's config answering for everybody.
//
// It also hard-coded Monday to Friday:
//
//   const isWeekday = !['Saturday','Sunday'].includes(day);
//
// Saturday is one of the biggest days on a car lot. Every dealer on the
// platform was telling Saturday callers they were closed.
//
// Hours live in settings_json.businessHours now, per day, and the spoken
// line is generated from the same data that decides open/closed — so Sarah
// can't announce hours that disagree with how she actually behaves.
'use strict';

const DAY_KEYS   = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABELS = {
  sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday',
  thu: 'Thursday', fri: 'Friday', sat: 'Saturday',
};

// What a car dealership actually runs, and therefore what a tenant gets
// before they touch anything: weekdays into the evening, a shorter Saturday,
// closed Sunday. A dealer who works Sundays just sets it.
const DEALER_DEFAULT = {
  tz: process.env.BUSINESS_TIMEZONE || 'America/Edmonton',
  days: {
    mon: { open: '09:00', close: '18:00' },
    tue: { open: '09:00', close: '18:00' },
    wed: { open: '09:00', close: '18:00' },
    thu: { open: '09:00', close: '18:00' },
    fri: { open: '09:00', close: '18:00' },
    sat: { open: '09:00', close: '17:00' },
    sun: null,   // null = closed
  },
};

function validTime(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return String(h).padStart(2, '0') + ':' + m[2];
}

// Accepts whatever is in settings and returns something safe to use. A day
// that is missing, malformed, or whose close is not after its open becomes
// closed rather than silently spanning midnight.
function normalizeHours(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = { tz: String(src.tz || DEALER_DEFAULT.tz), days: {} };
  const srcDays = (src.days && typeof src.days === 'object') ? src.days : null;
  for (const key of DAY_KEYS) {
    const d = srcDays ? srcDays[key] : DEALER_DEFAULT.days[key];
    if (!d || d.closed === true) { out.days[key] = null; continue; }
    const open = validTime(d.open), close = validTime(d.close);
    out.days[key] = (open && close && close > open) ? { open, close } : null;
  }
  return out;
}

// Current wall-clock time in the tenant's own zone — not the server's.
function nowInZone(tz) {
  const now = new Date();
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
  } catch {
    // An invalid tz string must not take the phone line down.
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Edmonton', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(now);
  }
  const get = t => (parts.find(p => p.type === t) || {}).value || '';
  const hour = parseInt(get('hour'), 10) % 24;   // en-US hour12:false can emit "24"
  return { day: get('weekday').toLowerCase().slice(0, 3), hhmm: String(hour).padStart(2, '0') + ':' + get('minute') };
}

function isOpenNow(rawHours) {
  const cfg = normalizeHours(rawHours);
  const { day, hhmm } = nowInZone(cfg.tz);
  const today = cfg.days[day];
  if (!today) return false;
  return hhmm >= today.open && hhmm < today.close;
}

// "9am", "5:30pm", "12pm" — read aloud by Polly, so no leading zeros and no
// 24-hour clock.
function spokenTime(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const period = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, '0')}${period}`;
}

// Turns the config into something a person would say. Consecutive days that
// share hours collapse — "9am to 6pm Monday through Friday, and 9am to 5pm
// Saturday" rather than reading seven rows off a table.
function describeHours(rawHours) {
  const cfg = normalizeHours(rawHours);
  const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const groups = [];
  for (const key of order) {
    const d = cfg.days[key];
    if (!d) continue;
    const last = groups[groups.length - 1];
    const contiguous = last && order.indexOf(key) === order.indexOf(last.keys[last.keys.length - 1]) + 1;
    if (last && contiguous && last.open === d.open && last.close === d.close) last.keys.push(key);
    else groups.push({ keys: [key], open: d.open, close: d.close });
  }
  if (!groups.length) return '';
  const phrases = groups.map(g => {
    const span = g.keys.length === 1
      ? DAY_LABELS[g.keys[0]]
      : g.keys.length === 2
        ? `${DAY_LABELS[g.keys[0]]} and ${DAY_LABELS[g.keys[1]]}`
        : `${DAY_LABELS[g.keys[0]]} through ${DAY_LABELS[g.keys[g.keys.length - 1]]}`;
    return `${spokenTime(g.open)} to ${spokenTime(g.close)} ${span}`;
  });
  if (phrases.length === 1) return phrases[0];
  return phrases.slice(0, -1).join(', ') + ', and ' + phrases[phrases.length - 1];
}

module.exports = {
  DAY_KEYS, DAY_LABELS, DEALER_DEFAULT,
  normalizeHours, isOpenNow, describeHours, spokenTime,
};
