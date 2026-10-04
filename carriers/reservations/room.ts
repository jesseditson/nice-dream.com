/**
 * The room and the calendar: which nights we seat, which tables a party takes,
 * and how bookings spread across the floor. Pure functions over `Rules`, so the
 * same logic prices availability and places a booking.
 *
 * Tables are "1".."N" for the 2-tops, numbered from `fourTopStart` for the
 * 4-tops, and "C1".."Cn" for the communal tables. Parties of 3 and 4 take a
 * 4-top, or adjacent 2-tops (1/2, 3/4, …) combined into one; anything larger
 * sits communal.
 *
 * The bar is its own area: seats "B1".."Bn", one guest each. A party only sits
 * there when it asks to, and the dining room never spills onto it.
 */

export type Rules = {
  timezone: string;
  slotMinutes: number;
  holdMinutes: number;
  weekendsAhead: number;
  twoTops: number;
  firstTable: number;
  fourTops: number;
  fourTopStart: number;
  communalTables: number;
  barSeats: number;
  maxParty: number;
  largePartyMin: number;
  /** First and last seating as minutes past midnight, by weekday (0 = Sunday). */
  seatings: Map<number, { first: number; last: number }>;
};

export type Area = "dining" | "bar";

export type Seating = "two" | "four" | "communal";

export type Booking = {
  date: string;
  /** Seating time as minutes past midnight. */
  start: number;
  tables: string[];
};

export type SlotAvailability = {
  time: number;
  two: boolean;
  four: boolean;
  communal: boolean;
  /** The largest party the bar can still seat together. */
  bar: number;
};

const PAIR_SEATS = 4;
const DAY_CODES = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// ---- time & date helpers ----------------------------------------------------

export const parseHHMM = (value: string): number | null => {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})(?:\s*([ap])\.?m?\.?)?$/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === "p" && hours < 12) hours += 12;
  if (meridiem === "a" && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
};

export const formatHHMM = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** `1110` → `"6:30 PM"`. */
export const formatClock = (minutes: number): string => {
  const hours24 = Math.floor(minutes / 60);
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${String(minutes % 60).padStart(2, "0")} ${hours24 < 12 ? "AM" : "PM"}`;
};

const splitDate = (date: string): [number, number, number] => {
  const [year, month, day] = date.split("-").map(Number);
  return [year, month, day];
};

export const isIsoDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);

/** Weekday of a `YYYY-MM-DD` string, 0 = Sunday. */
export const weekdayOf = (date: string): number => {
  const [year, month, day] = splitDate(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
};

export const addDays = (date: string, offset: number): string => {
  const [year, month, day] = splitDate(date);
  return new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10);
};

const ordinal = (day: number): string => {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  switch (day % 10) {
    case 1: return `${day}st`;
    case 2: return `${day}nd`;
    case 3: return `${day}rd`;
    default: return `${day}th`;
  }
};

/** `"2026-04-29"` → `"Wednesday, April 29th"`. */
export const formatDateLabel = (date: string): string => {
  const [, month, day] = splitDate(date);
  return `${WEEKDAYS[weekdayOf(date)]}, ${MONTHS[month - 1]} ${ordinal(day)}`;
};

/** Today's date in the restaurant's timezone, not the server's. */
export const todayIn = (timezone: string): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

/** Minutes past midnight right now, in the restaurant's timezone. */
export const nowMinutesIn = (timezone: string): number => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  let hours = 0;
  let minutes = 0;
  for (const part of parts) {
    if (part.type === "hour") hours = Number(part.value);
    if (part.type === "minute") minutes = Number(part.value);
  }
  return (hours % 24) * 60 + minutes;
};

/** A local timestamp for the sheet, e.g. `"2026-10-02 11:46"`. */
export const timestampIn = (timezone: string): string =>
  `${todayIn(timezone)} ${formatHHMM(nowMinutesIn(timezone))}`;

/** schema.org openingHours day shorthand (`"Th-Sa"`, `"Fr Sa"`, `"Sa-Mo"`) → weekday indexes. */
export const parseDays = (spec: string): number[] => {
  const days = new Set<number>();
  for (const token of spec.split(/[\s,]+/).filter(Boolean)) {
    const [from, to] = token.split("-");
    const start = DAY_CODES.indexOf(from);
    const end = to ? DAY_CODES.indexOf(to) : start;
    if (start < 0 || end < 0) continue;
    for (let day = start; ; day = (day + 1) % 7) {
      days.add(day);
      if (day === end) break;
    }
  }
  return [...days];
};

// ---- the calendar -----------------------------------------------------------

/** Every seating time offered on `date`, open or not. */
export const slotsOn = (date: string, rules: Rules): number[] => {
  const window = rules.seatings.get(weekdayOf(date));
  if (!window) return [];
  const slots: number[] = [];
  for (let time = window.first; time <= window.last; time += rules.slotMinutes) slots.push(time);
  return slots;
};

const mondayOf = (date: string): string => addDays(date, -((weekdayOf(date) + 6) % 7));

/**
 * The service dates the form offers: every seating night from `today` through
 * the end of the `weekendsAhead`-th week that still has a night left in it.
 */
export const serviceDates = (today: string, rules: Rules): string[] => {
  const dates: string[] = [];
  const weeks = new Set<string>();
  const limit = 7 * (rules.weekendsAhead + 2);
  for (let offset = 0; offset < limit; offset += 1) {
    const date = addDays(today, offset);
    if (!rules.seatings.has(weekdayOf(date))) continue;
    const week = mondayOf(date);
    if (!weeks.has(week)) {
      if (weeks.size >= rules.weekendsAhead) break;
      weeks.add(week);
    }
    dates.push(date);
  }
  return dates;
};

// ---- the floor --------------------------------------------------------------

export const seatingFor = (party: number): Seating =>
  party <= 2 ? "two" : party <= PAIR_SEATS ? "four" : "communal";

/** Tables held by any booking that overlaps a seating starting at `start`. */
export const occupiedAt = (
  bookings: Booking[],
  date: string,
  start: number,
  rules: Rules,
): Set<string> => {
  const taken = new Set<string>();
  for (const booking of bookings) {
    if (booking.date !== date) continue;
    const overlaps =
      booking.start < start + rules.holdMinutes && start < booking.start + rules.holdMinutes;
    if (overlaps) for (const table of booking.tables) taken.add(table);
  }
  return taken;
};

/**
 * Tables free for a seating starting at `start` but booked back-to-back with
 * it: a booking ends less than one slot before it, or starts less than one
 * slot after its hold is up, so staff would have to turn the table.
 */
export const turningAt = (
  bookings: Booking[],
  date: string,
  start: number,
  rules: Rules,
): Set<string> => {
  const end = start + rules.holdMinutes;
  const turning = new Set<string>();
  for (const booking of bookings) {
    if (booking.date !== date) continue;
    const bookingEnd = booking.start + rules.holdMinutes;
    const endsJustBefore = bookingEnd <= start && start - bookingEnd < rules.slotMinutes;
    const startsJustAfter = booking.start >= end && booking.start - end < rules.slotMinutes;
    if (endsJustBefore || startsJustAfter) for (const table of booking.tables) turning.add(table);
  }
  return turning;
};

// 4-top numbers aren't positions in the row of 2-tops, so only 2-tops count as neighbours.
const distanceFrom = (table: number, taken: Set<string>, rules: Rules): number => {
  let nearest = Infinity;
  for (const id of taken) {
    const other = Number(id);
    if (other >= 1 && other <= rules.twoTops) nearest = Math.min(nearest, Math.abs(other - table));
  }
  return nearest;
};

/**
 * The tables a party of this seating should get, or null when none are free.
 * A party of 3–4 takes a 4-top while one is free and a pair of 2-tops after
 * that. 2-tops and pairs go to whichever free spot is furthest from anyone
 * already seated, ties broken toward `firstTable`, so an empty room fills from
 * the middle outward and neighbours stay as far apart as the night allows.
 * Tables in `turning` are only used when nothing else fits.
 */
export const assignTables = (
  seating: Seating,
  taken: Set<string>,
  rules: Rules,
  turning: Set<string> = new Set(),
): string[] | null =>
  (turning.size ? pickTables(seating, new Set([...taken, ...turning]), taken, rules) : null) ??
  pickTables(seating, taken, taken, rules);

/** `blocked` tables can't be chosen; `taken` ones are the neighbours spacing keeps away from. */
const pickTables = (
  seating: Seating,
  blocked: Set<string>,
  taken: Set<string>,
  rules: Rules,
): string[] | null => {
  if (seating === "communal") {
    for (let index = 1; index <= rules.communalTables; index += 1) {
      const id = `C${index}`;
      if (!blocked.has(id)) return [id];
    }
    return null;
  }

  if (seating === "four") {
    for (let index = 0; index < rules.fourTops; index += 1) {
      const id = String(rules.fourTopStart + index);
      if (!blocked.has(id)) return [id];
    }
  }

  const candidates: number[][] = [];
  if (seating === "two") {
    for (let table = 1; table <= rules.twoTops; table += 1) candidates.push([table]);
  } else {
    for (let table = 1; table + 1 <= rules.twoTops; table += 2) candidates.push([table, table + 1]);
  }

  let best: number[] | null = null;
  let bestSpread = -Infinity;
  let bestCentre = Infinity;
  for (const tables of candidates) {
    if (tables.some((table) => blocked.has(String(table)))) continue;
    const spread = Math.min(...tables.map((table) => distanceFrom(table, taken, rules)));
    const centre = Math.min(...tables.map((table) => Math.abs(table - rules.firstTable)));
    if (spread > bestSpread || (spread === bestSpread && centre < bestCentre)) {
      best = tables;
      bestSpread = spread;
      bestCentre = centre;
    }
  }
  return best?.map(String) ?? null;
};

/** Each unbroken stretch of free bar seats, by seat number. */
const freeBarRuns = (taken: Set<string>, rules: Rules): number[][] => {
  const runs: number[][] = [];
  let run: number[] = [];
  for (let seat = 1; seat <= rules.barSeats; seat += 1) {
    if (!taken.has(`B${seat}`)) {
      run.push(seat);
      continue;
    }
    if (run.length) runs.push(run);
    run = [];
  }
  if (run.length) runs.push(run);
  return runs;
};

/**
 * Adjacent bar seats for a party, one each, or null when no stretch of free
 * seats is long enough. The party takes the shortest stretch that fits, from
 * its low end, so a longer one stays whole for a bigger party.
 */
export const assignBarSeats = (party: number, taken: Set<string>, rules: Rules): string[] | null => {
  if (party < 1) return null;
  let best: number[] | null = null;
  for (const run of freeBarRuns(taken, rules)) {
    if (run.length >= party && (!best || run.length < best.length)) best = run;
  }
  return best?.slice(0, party).map((seat) => `B${seat}`) ?? null;
};

/** Where a party sits in the area it asked for; a full area never borrows from the other. */
export const seatParty = (
  area: Area,
  party: number,
  taken: Set<string>,
  rules: Rules,
  turning: Set<string> = new Set(),
): string[] | null =>
  area === "bar"
    ? assignBarSeats(party, taken, rules)
    : assignTables(seatingFor(party), taken, rules, turning);

/**
 * What each seating on `date` can still take. Seatings at or before
 * `earliest` are closed — pass the current time for today, -1 otherwise.
 */
export const availabilityOn = (
  date: string,
  bookings: Booking[],
  rules: Rules,
  earliest: number,
): SlotAvailability[] =>
  slotsOn(date, rules).map((time) => {
    if (time <= earliest) return { time, two: false, four: false, communal: false, bar: 0 };
    const taken = occupiedAt(bookings, date, time, rules);
    return {
      time,
      two: assignTables("two", taken, rules) !== null,
      four: assignTables("four", taken, rules) !== null,
      communal: assignTables("communal", taken, rules) !== null,
      bar: Math.max(0, ...freeBarRuns(taken, rules).map((run) => run.length)),
    };
  });

// ---- rules from the dinner object --------------------------------------------

type DinnerConfig = {
  slot_minutes: number | null;
  hold_minutes: number | null;
  weekends_ahead: number | null;
  two_tops: number | null;
  first_table: number | null;
  four_tops: number | null;
  four_top_start: number | null;
  communal_tables: number | null;
  bar_seats: number | null;
  max_party: number | null;
  large_party_min: number | null;
  seatings: { days: string | null; first: string | null; last: string | null }[];
};

const whole = (value: number | null, fallback: number): number =>
  value != null && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;

export const readRules = (dinner: DinnerConfig): Rules => {
  const seatings = new Map<number, { first: number; last: number }>();
  for (const window of dinner.seatings) {
    const first = parseHHMM(window.first ?? "");
    const last = parseHHMM(window.last ?? "");
    if (first == null || last == null || last < first) continue;
    for (const day of parseDays(window.days ?? "")) seatings.set(day, { first, last });
  }
  const twoTops = whole(dinner.two_tops, 10);
  const communalTables = whole(dinner.communal_tables, 2);
  return {
    timezone: "America/Los_Angeles",
    slotMinutes: whole(dinner.slot_minutes, 30),
    holdMinutes: whole(dinner.hold_minutes, 90),
    weekendsAhead: whole(dinner.weekends_ahead, 3),
    twoTops,
    firstTable: Math.min(twoTops, whole(dinner.first_table, Math.ceil(twoTops / 2))),
    fourTops: whole(dinner.four_tops, 0),
    fourTopStart: Math.max(twoTops + 1, whole(dinner.four_top_start, twoTops + communalTables + 1)),
    communalTables,
    barSeats: whole(dinner.bar_seats, 0),
    maxParty: whole(dinner.max_party, 8),
    largePartyMin: whole(dinner.large_party_min, 6),
    seatings,
  };
};
