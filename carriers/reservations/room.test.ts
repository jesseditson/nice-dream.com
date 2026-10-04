import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type Booking,
  type Rules,
  type Seating,
  assignBarSeats,
  assignTables,
  availabilityOn,
  formatHHMM,
  holdFor,
  occupiedAt,
  parseHHMM,
  parsePartyRange,
  readRules,
  reconcileWalkIns,
  seatParty,
  seatingFor,
  tableForTicket,
  turningAt,
  walkInAt,
} from "./room.ts";

const THURSDAY = "2026-10-08";
const WEDNESDAY = "2026-10-07";

type Config = Parameters<typeof readRules>[0];

const room = (overrides: Partial<Config> = {}): Rules =>
  readRules({
    slot_minutes: 30,
    hold_minutes: 90,
    weekends_ahead: 3,
    two_tops: 10,
    first_table: 5,
    four_tops: 0,
    four_top_start: 13,
    communal_tables: 2,
    bar_seats: 4,
    max_party: 8,
    large_party_min: 6,
    seatings: [{ days: "Th-Sa", first: "17:30", last: "20:00" }],
    ...overrides,
  });

const withFourTops = (): Rules => room({ four_tops: 2 });

const at = (clock: string): number => parseHHMM(clock) ?? assert.fail(`bad time ${clock}`);

const taken = (...tables: (number | string)[]): Set<string> => new Set(tables.map(String));

const booking = (clock: string, ...tables: (number | string)[]): Booking => ({
  date: THURSDAY,
  start: at(clock),
  party: 2,
  tables: tables.map(String),
});

const partyOf = (party: number, clock: string, ...tables: (number | string)[]): Booking => ({
  ...booking(clock, ...tables),
  party,
});

/** Seats one kind of party into an empty room until it is full; pairs come back as "5/6". */
const fillOrder = (seating: Seating, rules: Rules): string[] => {
  const seated = new Set<string>();
  const order: string[] = [];
  for (
    let tables = assignTables(seating, seated, rules);
    tables;
    tables = assignTables(seating, seated, rules)
  ) {
    for (const table of tables) seated.add(table);
    order.push(tables.join("/"));
  }
  return order;
};

const heldAt = (
  clock: string,
  bookings: Booking[],
  rules: Rules = room(),
  hold = rules.holdMinutes,
): string[] => [...occupiedAt(bookings, THURSDAY, at(clock), hold, rules)].sort();

const KIND_PARTY: Record<Seating, number> = { two: 2, four: 4, communal: 5 };

const openSeatings = (
  kind: Seating | number,
  bookings: Booking[],
  rules: Rules = room(),
  earliest = -1,
): string[] => {
  const party = typeof kind === "number" ? kind : KIND_PARTY[kind];
  return availabilityOn(THURSDAY, bookings, rules, earliest)
    .filter((slot) => slot.dining.includes(party))
    .map((slot) => formatHHMM(slot.time));
};

describe("seatingFor", () => {
  test("parties of 1 and 2 take a 2-top", () => {
    assert.equal(seatingFor(1), "two");
    assert.equal(seatingFor(2), "two");
  });

  test("parties of 3 and 4 take a 4-top", () => {
    assert.equal(seatingFor(3), "four");
    assert.equal(seatingFor(4), "four");
  });

  test("parties of 5 and up sit communal", () => {
    assert.equal(seatingFor(5), "communal");
    assert.equal(seatingFor(8), "communal");
  });
});

describe("occupiedAt", () => {
  const sixThirty = [booking("18:30", 5)];

  test("a booking holds its table for every seating its hold overlaps", () => {
    for (const clock of ["17:30", "18:00", "18:30", "19:00", "19:30"]) {
      assert.deepEqual(heldAt(clock, sixThirty), ["5"], clock);
    }
  });

  test("the table is free again once the hold is up", () => {
    assert.deepEqual(heldAt("20:00", sixThirty), []);
  });

  test("the table is free for a seating that ends as the booking starts", () => {
    assert.deepEqual(heldAt("17:00", sixThirty), []);
  });

  test("the hold length comes from hold_minutes", () => {
    const hourHolds = room({ hold_minutes: 60 });
    assert.deepEqual(heldAt("19:00", sixThirty, hourHolds), ["5"]);
    assert.deepEqual(heldAt("19:30", sixThirty, hourHolds), []);
    assert.deepEqual(heldAt("17:30", sixThirty, hourHolds), []);
  });

  test("a combined booking holds both of its tables", () => {
    assert.deepEqual(heldAt("18:30", [booking("18:30", 9, 10)]), ["10", "9"]);
  });

  test("bookings on another date hold nothing", () => {
    const friday: Booking = { ...booking("18:30", 5), date: "2026-10-09" };
    assert.deepEqual(heldAt("18:30", [friday]), []);
  });

  test("collects every table held across overlapping bookings", () => {
    const bookings = [booking("18:00", 5), booking("19:00", 1), booking("20:00", 3)];
    assert.deepEqual(heldAt("18:30", bookings), ["1", "5"]);
  });

  test("a booking holds its table for its own party's hold", () => {
    const rules = room({ hold_overrides: [{ parties: "6-8", hold_minutes: 150 }] });
    const bookings = [partyOf(6, "18:00", "C1"), partyOf(2, "18:00", 5)];
    assert.deepEqual(heldAt("20:00", bookings, rules), ["C1"]);
  });

  test("the new seating's hold decides how far ahead it reaches", () => {
    const bookings = [booking("20:00", 5)];
    assert.deepEqual(heldAt("18:00", bookings, room(), 90), []);
    assert.deepEqual(heldAt("18:00", bookings, room(), 150), ["5"]);
  });
});

describe("hold overrides", () => {
  const overrides = room({
    hold_overrides: [
      { parties: "1-2", hold_minutes: 75 },
      { parties: "6+", hold_minutes: 150 },
    ],
  });

  test("parse a size, a range or an open-ended range", () => {
    assert.deepEqual(parsePartyRange("5"), { min: 5, max: 5 });
    assert.deepEqual(parsePartyRange(" 1 - 2 "), { min: 1, max: 2 });
    assert.deepEqual(parsePartyRange("6–8"), { min: 6, max: 8 });
    assert.deepEqual(parsePartyRange("6+"), { min: 6, max: Infinity });
  });

  test("reject anything that isn't a party range", () => {
    for (const spec of ["", "two", "0", "4-2", "1-", "-3"]) assert.equal(parsePartyRange(spec), null, spec);
  });

  test("a covered party size takes the override's hold", () => {
    assert.equal(holdFor(1, overrides), 75);
    assert.equal(holdFor(2, overrides), 75);
    assert.equal(holdFor(8, overrides), 150);
  });

  test("other party sizes keep hold_minutes", () => {
    assert.equal(holdFor(3, overrides), 90);
    assert.equal(holdFor(5, overrides), 90);
  });

  test("the first matching override wins", () => {
    const rules = room({
      hold_overrides: [
        { parties: "6", hold_minutes: 120 },
        { parties: "5-8", hold_minutes: 150 },
      ],
    });
    assert.equal(holdFor(6, rules), 120);
    assert.equal(holdFor(7, rules), 150);
  });

  test("overrides with a bad range or no hold are ignored", () => {
    const rules = room({
      hold_overrides: [
        { parties: "lots", hold_minutes: 150 },
        { parties: "3-4", hold_minutes: null },
        { parties: "1-2", hold_minutes: 0 },
      ],
    });
    assert.deepEqual(rules.holdOverrides, []);
  });

  test("a longer hold closes seatings a shorter one leaves open", () => {
    const rules = room({ hold_overrides: [{ parties: "6-8", hold_minutes: 150 }] });
    const bookings = [booking("19:30", "C1"), booking("20:00", "C2")];
    assert.deepEqual(openSeatings(5, bookings, rules), ["17:30", "18:00", "18:30"]);
    assert.deepEqual(openSeatings(6, bookings, rules), ["17:30"]);
  });
});

describe("turningAt", () => {
  const turningAtClock = (clock: string, bookings: Booking[], rules: Rules = room()): string[] =>
    [...turningAt(bookings, THURSDAY, at(clock), rules.holdMinutes, rules)].sort();

  test("a table whose booking ends as the seating starts is turning", () => {
    assert.deepEqual(turningAtClock("19:30", [booking("18:00", 13)]), ["13"]);
  });

  test("a table booked as the seating's hold ends is turning", () => {
    assert.deepEqual(turningAtClock("18:00", [booking("19:30", 5, 6)]), ["5", "6"]);
  });

  test("a free slot between bookings is enough", () => {
    assert.deepEqual(turningAtClock("20:00", [booking("18:00", 13)]), []);
    assert.deepEqual(turningAtClock("17:30", [booking("19:30", 13)]), []);
  });

  test("overlapping bookings are held, not turning", () => {
    assert.deepEqual(turningAtClock("19:00", [booking("18:00", 13)]), []);
  });

  test("each booking ends after its own party's hold", () => {
    const rules = room({ hold_overrides: [{ parties: "3-4", hold_minutes: 60 }] });
    assert.deepEqual(turningAtClock("19:00", [partyOf(4, "18:00", 13)], rules), ["13"]);
    assert.deepEqual(turningAtClock("19:30", [partyOf(4, "18:00", 13)], rules), []);
  });

  test("bookings on another date don't turn anything", () => {
    assert.deepEqual(turningAtClock("19:30", [{ ...booking("18:00", 13), date: WEDNESDAY }]), []);
  });
});

describe("assignTables avoiding back-to-back bookings", () => {
  test("a party of 3–4 takes the other 4-top rather than turning one", () => {
    assert.deepEqual(assignTables("four", taken(), withFourTops(), taken(13)), ["14"]);
  });

  test("prefers a pair of 2-tops to turning a 4-top", () => {
    assert.deepEqual(assignTables("four", taken(), withFourTops(), taken(13, 14)), ["5", "6"]);
  });

  test("turns a table when nothing else is free", () => {
    assert.deepEqual(assignTables("four", taken(14, 1, 3, 5, 7, 9), withFourTops(), taken(13)), ["13"]);
    assert.deepEqual(assignTables("two", taken(1, 2, 3, 4, 6, 7, 8, 9, 10), room(), taken(5)), ["5"]);
  });

  test("a party of two skips a turning 2-top", () => {
    assert.deepEqual(assignTables("two", taken(), room(), taken(5)), ["4"]);
  });

  test("turning tables don't push neighbours away", () => {
    assert.deepEqual(assignTables("two", taken(1), room(), taken(10)), ["9"]);
  });

  test("communal parties take the other communal table", () => {
    assert.deepEqual(assignTables("communal", taken(), room(), taken("C1")), ["C2"]);
  });

  test("seatParty steers a later dining party off the earlier one's table", () => {
    const bookings = [booking("18:00", 13)];
    const rules = withFourTops();
    const at730 = at("19:30");
    const tables = seatParty(
      "dining",
      4,
      occupiedAt(bookings, THURSDAY, at730, rules.holdMinutes, rules),
      rules,
      turningAt(bookings, THURSDAY, at730, rules.holdMinutes, rules),
    );
    assert.deepEqual(tables, ["14"]);
  });
});

describe("assignTables for parties of 1–2", () => {
  test("an empty room starts at first_table", () => {
    assert.deepEqual(assignTables("two", taken(), room()), ["5"]);
  });

  test("first_table moves where the night starts", () => {
    assert.deepEqual(assignTables("two", taken(), room({ first_table: 2 })), ["2"]);
  });

  test("the next party goes as far from the first as it can", () => {
    assert.deepEqual(assignTables("two", taken(5), room()), ["10"]);
  });

  test("picks the free table furthest from its nearest taken neighbour", () => {
    assert.deepEqual(assignTables("two", taken(1, 10), room()), ["5"]);
    assert.deepEqual(assignTables("two", taken(1, 2, 3), room()), ["10"]);
  });

  test("equally spaced tables tie-break toward first_table", () => {
    assert.deepEqual(assignTables("two", taken(1, 3, 5, 10), room()), ["7"]);
  });

  test("tables equally spaced and equally central tie-break to the lowest number", () => {
    assert.deepEqual(assignTables("two", taken(1, 5, 10), room()), ["3"]);
  });

  test("fills an empty room in a fixed order", () => {
    assert.deepEqual(fillOrder("two", room()), ["5", "10", "1", "3", "7", "4", "6", "2", "8", "9"]);
  });

  test("returns null when every 2-top is taken", () => {
    assert.equal(assignTables("two", taken(1, 2, 3, 4, 5, 6, 7, 8, 9, 10), room()), null);
  });

  test("never falls back to a 4-top or a communal table", () => {
    const full = taken(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
    assert.equal(assignTables("two", full, withFourTops()), null);
  });

  test("4-tops and communal tables are not neighbours", () => {
    assert.deepEqual(assignTables("two", taken(13, 14, "C1", "C2"), withFourTops()), ["5"]);
    assert.deepEqual(assignTables("two", taken(5, 13), withFourTops()), ["10"]);
  });

  test("respects the number of 2-tops", () => {
    assert.deepEqual(fillOrder("two", room({ two_tops: 4, first_table: 2 })), ["2", "4", "1", "3"]);
  });
});

describe("assignTables for parties of 3–4, combining 2-tops", () => {
  test("an empty room starts at the pair holding first_table", () => {
    assert.deepEqual(assignTables("four", taken(), room()), ["5", "6"]);
  });

  test("fills an empty room pair by pair in a fixed order", () => {
    assert.deepEqual(fillOrder("four", room()), ["5/6", "1/2", "9/10", "3/4", "7/8"]);
  });

  test("a pair is measured from whichever of its tables is closer to a neighbour", () => {
    assert.deepEqual(assignTables("four", taken(8), room()), ["1", "2"]);
  });

  test("a pair needs both of its tables free", () => {
    assert.deepEqual(assignTables("four", taken(6), room()), ["1", "2"]);
  });

  test("only the fixed pairs combine", () => {
    assert.equal(assignTables("four", taken(1, 4, 5, 8, 9), room()), null);
  });

  test("spread-out 2-tops can leave no pair even with tables free", () => {
    assert.equal(assignTables("four", taken(5, 10, 1, 3, 7), room()), null);
  });

  test("an odd 2-top is left out of the pairs", () => {
    assert.deepEqual(fillOrder("four", room({ two_tops: 5, first_table: 3 })), ["3/4", "1/2"]);
  });
});

describe("assignTables for parties of 3–4, with 4-tops", () => {
  test("takes the first 4-top before combining 2-tops", () => {
    assert.deepEqual(assignTables("four", taken(), withFourTops()), ["13"]);
  });

  test("takes the next 4-top when the first is held", () => {
    assert.deepEqual(assignTables("four", taken(13), withFourTops()), ["14"]);
  });

  test("falls back to a pair once the 4-tops are held", () => {
    assert.deepEqual(assignTables("four", taken(13, 14), withFourTops()), ["5", "6"]);
  });

  test("fills 4-tops first, then pairs", () => {
    assert.deepEqual(fillOrder("four", withFourTops()), [
      "13",
      "14",
      "5/6",
      "1/2",
      "9/10",
      "3/4",
      "7/8",
    ]);
  });

  test("a 4-top seats a party when every pair is broken up", () => {
    assert.deepEqual(assignTables("four", taken(5, 10, 1, 3, 7), withFourTops()), ["13"]);
  });

  test("returns null when 4-tops and pairs are all gone", () => {
    assert.equal(assignTables("four", taken(5, 10, 1, 3, 7, 13, 14), withFourTops()), null);
  });

  test("4-tops are numbered up from four_top_start", () => {
    const rules = room({ four_tops: 3, four_top_start: 21 });
    assert.deepEqual(fillOrder("four", rules).slice(0, 3), ["21", "22", "23"]);
  });

  test("no 4-tops exist while four_tops is 0", () => {
    assert.deepEqual(assignTables("four", taken(), room({ four_tops: 0 })), ["5", "6"]);
  });
});

describe("assignTables for parties of 5 and up", () => {
  test("takes communal tables in order", () => {
    assert.deepEqual(fillOrder("communal", room()), ["C1", "C2"]);
  });

  test("takes the second table when the first is held", () => {
    assert.deepEqual(assignTables("communal", taken("C1"), room()), ["C2"]);
  });

  test("returns null when the communal tables are held, whatever else is free", () => {
    assert.equal(assignTables("communal", taken("C1", "C2"), withFourTops()), null);
  });

  test("respects the number of communal tables", () => {
    assert.deepEqual(fillOrder("communal", room({ communal_tables: 1 })), ["C1"]);
  });
});

describe("assignBarSeats", () => {
  const everyTable = taken(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14, "C1", "C2");

  test("a solo guest takes the first seat", () => {
    assert.deepEqual(assignBarSeats(1, taken(), room()), ["B1"]);
  });

  test("a party gets one adjacent seat each", () => {
    assert.deepEqual(assignBarSeats(3, taken(), room()), ["B1", "B2", "B3"]);
  });

  test("a party as large as the bar takes every seat", () => {
    assert.deepEqual(assignBarSeats(4, taken(), room()), ["B1", "B2", "B3", "B4"]);
  });

  test("the next party sits beside the last", () => {
    assert.deepEqual(assignBarSeats(2, taken("B1", "B2"), room()), ["B3", "B4"]);
  });

  test("takes the shortest stretch that fits", () => {
    assert.deepEqual(assignBarSeats(1, taken("B2"), room()), ["B1"]);
    assert.deepEqual(assignBarSeats(2, taken("B2"), room()), ["B3", "B4"]);
  });

  test("leaves a longer stretch whole for a bigger party", () => {
    const longBar = room({ bar_seats: 6 });
    assert.deepEqual(assignBarSeats(2, taken("B3"), longBar), ["B1", "B2"]);
    assert.deepEqual(assignBarSeats(3, taken("B3"), longBar), ["B4", "B5", "B6"]);
  });

  test("equal stretches go to the lower seats", () => {
    assert.deepEqual(assignBarSeats(1, taken("B2", "B3"), room()), ["B1"]);
  });

  test("never splits a party across a taken seat", () => {
    assert.equal(assignBarSeats(3, taken("B2"), room()), null);
    assert.equal(assignBarSeats(2, taken("B2", "B4"), room()), null);
  });

  test("refuses a party larger than the bar", () => {
    assert.equal(assignBarSeats(5, taken(), room()), null);
  });

  test("refuses when every seat is taken", () => {
    assert.equal(assignBarSeats(1, taken("B1", "B2", "B3", "B4"), room()), null);
  });

  test("refuses a party of none", () => {
    assert.equal(assignBarSeats(0, taken(), room()), null);
  });

  test("there is no bar while bar_seats is 0", () => {
    assert.equal(assignBarSeats(1, taken(), room({ bar_seats: 0 })), null);
  });

  test("ignores what is taken in the dining room", () => {
    assert.deepEqual(assignBarSeats(2, everyTable, room()), ["B1", "B2"]);
  });
});

describe("seatParty", () => {
  const diningFull = taken(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, "C1", "C2");
  const barFull = taken("B1", "B2", "B3", "B4");

  test("seats a dining-room party at a table", () => {
    assert.deepEqual(seatParty("dining", 2, taken(), room()), ["5"]);
    assert.deepEqual(seatParty("dining", 4, taken(), room()), ["5", "6"]);
    assert.deepEqual(seatParty("dining", 6, taken(), room()), ["C1"]);
  });

  test("seats a bar party at the bar", () => {
    assert.deepEqual(seatParty("bar", 2, taken(), room()), ["B1", "B2"]);
  });

  test("a full dining room never overflows onto an empty bar", () => {
    for (const party of [1, 2, 3, 4, 5, 8]) {
      assert.equal(seatParty("dining", party, diningFull, room()), null, `party of ${party}`);
    }
  });

  test("a full bar never overflows into an empty dining room", () => {
    for (const party of [1, 2, 3, 4]) {
      assert.equal(seatParty("bar", party, barFull, room()), null, `party of ${party}`);
    }
  });

  test("a bar party too big for the bar is not moved to a table", () => {
    assert.equal(seatParty("bar", 6, taken(), room()), null);
  });

  test("guests at the bar are not neighbours for the 2-top spread", () => {
    assert.deepEqual(seatParty("dining", 2, barFull, room()), ["5"]);
  });
});

describe("availabilityOn", () => {
  const busyNight = [
    ...[5, 10, 1, 3, 7].map((table) => booking("18:30", table)),
    booking("19:00", "C1"),
    booking("19:00", "C2"),
  ];
  const everySeating = ["17:30", "18:00", "18:30", "19:00", "19:30", "20:00"];

  test("lists every seating of the night", () => {
    const seatings = availabilityOn(THURSDAY, [], room(), -1).map((slot) => formatHHMM(slot.time));
    assert.deepEqual(seatings, everySeating);
  });

  test("an empty night is open to every party size", () => {
    for (const kind of ["two", "four", "communal"] as const) {
      assert.deepEqual(openSeatings(kind, []), everySeating, kind);
    }
  });

  test("a night with no service has no seatings", () => {
    assert.deepEqual(availabilityOn(WEDNESDAY, [], room(), -1), []);
  });

  test("2-tops stay open while any is free", () => {
    assert.deepEqual(openSeatings("two", busyNight), everySeating);
  });

  test("parties of 3–4 are closed out wherever the broken pairs overlap", () => {
    assert.deepEqual(openSeatings("four", busyNight), ["20:00"]);
  });

  test("4-tops keep parties of 3–4 open through the same night", () => {
    assert.deepEqual(openSeatings("four", busyNight, withFourTops()), everySeating);
  });

  test("communal seatings close wherever both tables' holds overlap", () => {
    assert.deepEqual(openSeatings("communal", busyNight), ["17:30"]);
  });

  test("seatings at or before the cutoff are closed to everyone", () => {
    const afterSix = ["18:30", "19:00", "19:30", "20:00"];
    for (const kind of ["two", "four", "communal"] as const) {
      assert.deepEqual(openSeatings(kind, [], room(), at("18:00")), afterSix, kind);
    }
  });

  const barRoom = (bookings: Booking[], rules: Rules = room(), earliest = -1): number[] =>
    availabilityOn(THURSDAY, bookings, rules, earliest).map((slot) => Math.max(0, ...slot.bar));

  test("an empty bar can take a party as large as the bar at every seating", () => {
    assert.deepEqual(barRoom([]), [4, 4, 4, 4, 4, 4]);
  });

  test("reports the longest free stretch of the bar while seats are held", () => {
    assert.deepEqual(barRoom([booking("18:30", "B1", "B2")]), [2, 2, 2, 2, 2, 4]);
    assert.deepEqual(barRoom([booking("18:30", "B2")]), [2, 2, 2, 2, 2, 4]);
  });

  test("a full dining room leaves the bar open, and a full bar leaves the dining room open", () => {
    assert.deepEqual(barRoom(busyNight), [4, 4, 4, 4, 4, 4]);
    const fullBar = [booking("18:30", "B1", "B2", "B3", "B4")];
    assert.deepEqual(barRoom(fullBar), [0, 0, 0, 0, 0, 4]);
    assert.deepEqual(openSeatings("two", fullBar), everySeating);
  });

  test("the bar is closed at seatings at or before the cutoff", () => {
    assert.deepEqual(barRoom([], room(), at("18:00")), [0, 0, 4, 4, 4, 4]);
  });

  test("there is no bar room while bar_seats is 0", () => {
    assert.deepEqual(barRoom([], room({ bar_seats: 0 })), [0, 0, 0, 0, 0, 0]);
  });
});

describe("tableForTicket", () => {
  test("reads the names Square gives the 2-tops and bar seats", () => {
    assert.equal(tableForTicket("* 5", room()), "5");
    assert.equal(tableForTicket("* 10", room()), "10");
    assert.equal(tableForTicket("Bar 1", room()), "B1");
    assert.equal(tableForTicket("bar4", room()), "B4");
  });

  test("the numbers after the last 2-top are the communal tables", () => {
    assert.equal(tableForTicket("11", room()), "C1");
    assert.equal(tableForTicket("12", room()), "C2");
    assert.equal(tableForTicket("13", room()), null);
  });

  test("a 4-top keeps its own number", () => {
    assert.equal(tableForTicket("13", withFourTops()), "13");
    assert.equal(tableForTicket("14", withFourTops()), "14");
    assert.equal(tableForTicket("11", room({ four_tops: 2, four_top_start: 11 })), "11");
  });

  test("takes the Tracker's own names too", () => {
    assert.equal(tableForTicket("7", room()), "7");
    assert.equal(tableForTicket("C2", room()), "C2");
    assert.equal(tableForTicket("B3", room()), "B3");
  });

  test("anything else isn't a table", () => {
    for (const ticket of ["", "Togo", "Front", "Danielle", "0", "* 15", "Bar 5", "C3", "5 6"]) {
      assert.equal(tableForTicket(ticket, room()), null, ticket);
    }
  });
});

describe("walkInAt", () => {
  const walkIn = (ticket: string, clock: string, rules: Rules = room(), date = THURSDAY): Booking | null =>
    walkInAt(ticket, date, at(clock), rules);

  test("holds the table from the minute the ticket opens", () => {
    assert.deepEqual(walkIn("* 5", "18:42"), { date: THURSDAY, start: at("18:42"), party: 2, tables: ["5"] });
  });

  test("assumes the table is full", () => {
    assert.equal(walkIn("* 5", "18:00")?.party, 2);
    assert.equal(walkIn("13", "18:00", withFourTops())?.party, 4);
    assert.equal(walkIn("11", "18:00")?.party, 8);
    assert.equal(walkIn("Bar 2", "18:00")?.party, 1);
  });

  test("a walk-in blocks the seatings its hold runs into", () => {
    const seated = walkIn("* 5", "18:42") ?? assert.fail("not held");
    assert.deepEqual(heldAt("18:30", [seated]), ["5"]);
    assert.deepEqual(heldAt("20:00", [seated]), ["5"]);
    assert.deepEqual(heldAt("17:00", [seated]), []);
    assert.deepEqual(heldAt("20:12", [seated]), []);
  });

  test("a party seated before service is held only if it will still be there at the first seating", () => {
    assert.equal(walkIn("* 5", "16:00"), null);
    assert.deepEqual(walkIn("* 5", "16:01")?.tables, ["5"]);
    assert.deepEqual(walkIn("* 5", "17:30")?.tables, ["5"]);
  });

  test("the hold follows the party-size overrides", () => {
    const rules = room({ hold_overrides: [{ parties: "6+", hold_minutes: 150 }] });
    assert.equal(walkIn("* 5", "15:30", rules), null);
    assert.deepEqual(walkIn("11", "15:30", rules)?.tables, ["C1"]);
  });

  test("nothing is held after the last seating or on a night without service", () => {
    assert.deepEqual(walkIn("* 5", "20:00")?.tables, ["5"]);
    assert.equal(walkIn("* 5", "20:01"), null);
    assert.equal(walkIn("* 5", "18:00", room(), WEDNESDAY), null);
  });

  test("a ticket that isn't a table holds nothing", () => {
    assert.equal(walkIn("Togo", "18:00"), null);
  });
});

describe("reconcileWalkIns", () => {
  const check = (id: string, name: string, clock: string, date = THURSDAY) => ({ id, name, date, start: at(clock) });
  const walkIn = (id: string, clock: string, ...tables: (number | string)[]): Booking => ({
    ...booking(clock, ...tables),
    check: id,
  });
  const seat = (bookings: Booking[], ...checks: ReturnType<typeof check>[]) =>
    reconcileWalkIns(bookings, checks, room());

  test("a check on a table nobody booked seats a walk-in from when it was opened", () => {
    assert.deepEqual(seat([], check("A", "* 5", "18:42")), {
      left: [],
      seated: [{ date: THURSDAY, start: at("18:42"), party: 2, tables: ["5"], check: "A" }],
    });
  });

  test("a walk-in already on the Tracker is seated once", () => {
    const tracked = [walkIn("A", "18:42", 5)];
    assert.deepEqual(seat(tracked, check("A", "* 5", "18:42")), { left: [], seated: [] });
  });

  test("a walk-in has left once its check is closed", () => {
    const tracked = [walkIn("A", "18:42", 5), booking("18:30", 3)];
    assert.deepEqual(seat(tracked), { left: [tracked[0]], seated: [] });
  });

  test("a check moved to another table leaves the old one and seats the new one", () => {
    const tracked = [walkIn("A", "18:42", 5)];
    const { left, seated } = seat(tracked, check("A", "* 7", "18:42"));
    assert.deepEqual(left, tracked);
    assert.deepEqual(seated.map((moved) => moved.tables), [["7"]]);
  });

  test("a walk-in's row keeps tables staff added to it", () => {
    const tracked = [walkIn("A", "18:42", 5, 6)];
    assert.deepEqual(seat(tracked, check("A", "* 5", "18:42")), { left: [], seated: [] });
  });

  test("a check written down twice keeps one row", () => {
    const tracked = [walkIn("A", "18:42", 5), walkIn("A", "18:42", 5)];
    assert.deepEqual(seat(tracked, check("A", "* 5", "18:42")), { left: [tracked[1]], seated: [] });
  });

  test("the booked party's own check seats nobody new", () => {
    const booked = [booking("18:30", 5), partyOf(4, "19:00", 7, 8)];
    for (const own of [check("A", "* 5", "18:10"), check("B", "* 5", "18:55"), check("C", "* 8", "19:05")]) {
      assert.deepEqual(seat(booked, own), { left: [], seated: [] }, own.name);
    }
  });

  test("a booking is never marked as having left", () => {
    assert.deepEqual(seat([booking("18:30", 5)]).left, []);
  });

  test("a party seated once the booked one has left is a walk-in", () => {
    const { seated } = seat([booking("18:00", 5)], check("A", "* 5", "19:10"));
    assert.deepEqual(seated.map((late) => [late.tables, late.start]), [[["5"], at("19:10")]]);
  });

  test("a second check on a walk-in's table seats nobody new", () => {
    const { seated } = seat([], check("A", "* 5", "18:00"), check("B", "* 5", "18:20"));
    assert.deepEqual(seated.map((first) => first.check), ["A"]);
  });

  test("checks that aren't tables, or won't last into a seating, seat nobody", () => {
    const { seated } = seat([], check("A", "Togo", "18:00"), check("B", "* 5", "12:30"), check("C", "* 6", "18:00", WEDNESDAY));
    assert.deepEqual(seated, []);
  });

  test("the form stops offering a seating once every table has a booking or a walk-in", () => {
    const twoTopsAtSeven = (bookings: Booking[]): number[] =>
      availabilityOn(THURSDAY, bookings, room(), -1)
        .filter((slot) => slot.time === at("19:00"))
        .flatMap((slot) => slot.dining.filter((party) => party <= 2));
    const booked = [1, 2, 3, 4, 6, 7, 8, 9, 10].map((table) => booking("19:00", table));
    assert.deepEqual(twoTopsAtSeven(booked), [1, 2]);
    assert.deepEqual(twoTopsAtSeven([...booked, ...seat(booked, check("A", "* 5", "18:42")).seated]), []);
  });
});

describe("readRules table settings", () => {
  const unset: Config = {
    slot_minutes: null,
    hold_minutes: null,
    weekends_ahead: null,
    two_tops: null,
    first_table: null,
    four_tops: null,
    four_top_start: null,
    communal_tables: null,
    bar_seats: null,
    max_party: null,
    large_party_min: null,
    seatings: [],
  };

  test("defaults to ten 2-tops, no 4-tops, two communal tables and no bar", () => {
    const rules = readRules(unset);
    assert.equal(rules.twoTops, 10);
    assert.equal(rules.firstTable, 5);
    assert.equal(rules.fourTops, 0);
    assert.equal(rules.fourTopStart, 13);
    assert.equal(rules.communalTables, 2);
    assert.equal(rules.barSeats, 0);
    assert.equal(rules.holdMinutes, 90);
  });

  test("first_table defaults to the middle of the row", () => {
    assert.equal(readRules({ ...unset, two_tops: 6 }).firstTable, 3);
  });

  test("first_table cannot sit past the last 2-top", () => {
    assert.equal(room({ first_table: 12 }).firstTable, 10);
  });

  test("four_top_start defaults to just past the 2-tops and communal tables", () => {
    assert.equal(readRules({ ...unset, two_tops: 6, communal_tables: 3 }).fourTopStart, 10);
  });

  test("four_top_start cannot reuse a 2-top's number", () => {
    assert.equal(room({ four_top_start: 5 }).fourTopStart, 11);
  });
});
