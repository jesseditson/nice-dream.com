import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type Booking,
  type Rules,
  type Seating,
  assignTables,
  availabilityOn,
  formatHHMM,
  occupiedAt,
  parseHHMM,
  readRules,
  seatingFor,
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
  tables: tables.map(String),
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

const heldAt = (clock: string, bookings: Booking[], rules: Rules = room()): string[] =>
  [...occupiedAt(bookings, THURSDAY, at(clock), rules)].sort();

const openSeatings = (
  kind: Seating,
  bookings: Booking[],
  rules: Rules = room(),
  earliest = -1,
): string[] =>
  availabilityOn(THURSDAY, bookings, rules, earliest)
    .filter((slot) => slot[kind])
    .map((slot) => formatHHMM(slot.time));

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
    const friday: Booking = { date: "2026-10-09", start: at("18:30"), tables: ["5"] };
    assert.deepEqual(heldAt("18:30", [friday]), []);
  });

  test("collects every table held across overlapping bookings", () => {
    const bookings = [booking("18:00", 5), booking("19:00", 1), booking("20:00", 3)];
    assert.deepEqual(heldAt("18:30", bookings), ["1", "5"]);
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
    max_party: null,
    large_party_min: null,
    seatings: [],
  };

  test("defaults to ten 2-tops, no 4-tops and two communal tables", () => {
    const rules = readRules(unset);
    assert.equal(rules.twoTops, 10);
    assert.equal(rules.firstTable, 5);
    assert.equal(rules.fourTops, 0);
    assert.equal(rules.fourTopStart, 13);
    assert.equal(rules.communalTables, 2);
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
