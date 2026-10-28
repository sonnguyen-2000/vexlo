'use strict';
/* Download schedule: at the start time every waiting / paused download is resumed, at the stop time the active ones are paused.
 * Pure functions, unit-tested. `state` remembers which day each event already fired so it runs once per day. */

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function toMinutes(hhmm) {
  const m = HHMM.exec(String(hhmm || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

/**
 * @param {Date} now
 * @param {{enabled:boolean,start:string,stop:string,days:number[]}} sched   days: 0=Sunday .. 6=Saturday
 * @param {{start?:string,stop?:string}} state  mutated: last day each action fired
 * @param {number} graceMin an event missed by a short sleep / lag still fires within this many minutes
 * @returns {('start'|'stop')[]}
 */
function dueActions(now, sched, state, graceMin = 10) {
  const out = [];
  if (!sched || !sched.enabled) { return out; }
  const days = Array.isArray(sched.days) && sched.days.length ? sched.days : [0, 1, 2, 3, 4, 5, 6];
  if (!days.includes(now.getDay())) { return out; }
  const cur = now.getHours() * 60 + now.getMinutes();
  const today = dayKey(now);
  for (const kind of ['start', 'stop']) {
    const at = toMinutes(sched[kind]);
    if (at < 0 || state[kind] === today) { continue; }
    if (cur >= at && cur < at + graceMin) { state[kind] = today; out.push(kind); }
  }
  return out;
}

module.exports = { dueActions, toMinutes };
