import assert from "node:assert/strict";
import { afterEach, describe, mock, test } from "node:test";
import type { SheetsClient } from "./google.ts";
import { type OpenTicket, type Rules, readRules } from "./room.ts";
import { type NewBooking, type TrackerBooking, appendBooking, readBookings, syncWalkIns } from "./sheet.ts";

const THURSDAY = "2026-10-08";
const SERIAL = (Date.UTC(2026, 9, 8) - Date.UTC(1899, 11, 30)) / 86_400_000;
const SIX_FORTY_TWO = 18 * 60 + 42;

const rules: Rules = readRules({
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
});

type Call = { method: string; path: string; body: any };

/** Stands in for the spreadsheet: serves `rows` as the Tracker and records every call. */
const sheet = (
  rows: unknown[][] = [],
  failWrites = false,
  appended = (count: number) => `Tracker!A9:M${8 + count}`,
): { client: SheetsClient; writes: () => Call[] } => {
  const calls: Call[] = [];
  const client = (async (method: string, path: string, body?: unknown) => {
    calls.push({ method, path: decodeURIComponent(path), body });
    if (method === "GET" && path.startsWith("/values/")) return { values: rows };
    if (method === "GET") return { sheets: [{ properties: { sheetId: 7, title: "Tracker" } }] };
    if (failWrites) throw new Error("Sheets is down");
    if (path.includes(":append")) return { updates: { updatedRange: appended((body as any).values.length) } };
    return {};
  }) as SheetsClient;
  return { client, writes: () => calls.filter((call) => call.method !== "GET") };
};

const check = (id: string, name: string, start = SIX_FORTY_TWO): OpenTicket => ({ id, name, date: THURSDAY, start });

const walkIn = (row: number, id: string, table: string): TrackerBooking => ({
  date: THURSDAY,
  start: SIX_FORTY_TWO,
  party: 2,
  tables: [table],
  check: id,
  row,
});

describe("syncWalkIns", () => {
  afterEach(() => mock.restoreAll());

  test("writes a row for each walk-in Square has seated", async () => {
    const { client, writes } = sheet();
    const held = await syncWalkIns(client, [], [check("A", "* 5"), check("B", "Bar 2")], rules);

    assert.deepEqual(held.map((booking) => booking.tables), [["5"], ["B2"]]);
    const [append, checkboxes] = writes();
    assert.match(append.path, /^\/values\/Tracker!A1:M1:append/);
    assert.deepEqual(
      append.body.values.map((row: unknown[]) => row.slice(0, 12)),
      [
        [SERIAL, "Walk-in", SIX_FORTY_TWO / 1440, 2, "Square", "A", "", "5", "", true, "booked", false],
        [SERIAL, "Walk-in", SIX_FORTY_TWO / 1440, 1, "Square", "B", "", "B2", "", true, "booked", false],
      ],
    );
    const { startRowIndex, endRowIndex } = checkboxes.body.requests[0].setDataValidation.range;
    assert.deepEqual([startRowIndex, endRowIndex], [8, 10]);
    assert.equal(writes().length, 2);
  });

  test("marks a walk-in as left when its check has closed, and lets go of its table", async () => {
    const { client, writes } = sheet();
    const bookings = [walkIn(4, "A", "5"), walkIn(6, "B", "7")];
    const held = await syncWalkIns(client, bookings, [check("B", "* 7")], rules);

    assert.deepEqual(held, [bookings[1]]);
    assert.deepEqual(writes().map((call) => [call.path, call.body.data]), [
      ["/values:batchUpdate", [{ range: "Tracker!K4", values: [["left"]] }]],
    ]);
  });

  test("writes nothing when the Tracker already matches Square", async () => {
    const { client, writes } = sheet();
    const bookings = [walkIn(4, "A", "5")];
    assert.deepEqual(await syncWalkIns(client, bookings, [check("A", "* 5")], rules), bookings);
    assert.deepEqual(writes(), []);
  });

  test("leaves the Tracker alone when Square didn't answer", async () => {
    const { client, writes } = sheet();
    const bookings = [walkIn(4, "A", "5")];
    assert.deepEqual(await syncWalkIns(client, bookings, null, rules), bookings);
    assert.deepEqual(writes(), []);
  });

  test("a walk-in still holds its table when its row can't be written", async () => {
    mock.method(console, "error", () => {});
    const { client } = sheet([], true);
    const held = await syncWalkIns(client, [], [check("A", "* 5")], rules);
    assert.deepEqual(held.map((booking) => booking.tables), [["5"]]);
  });
});

describe("readBookings", () => {
  const row = (overrides: Record<number, unknown> = {}): unknown[] =>
    Object.assign([SERIAL, "Ada", 18.5 / 24, 2, "Email", "ada@example.com", "", "5", "", false, "booked", false, ""], overrides);

  test("reads a walk-in's check off its row, and the row each booking is on", async () => {
    const { client } = sheet([row(), row({ 1: "Walk-in", 4: "Square", 5: "ORDER", 7: "7" })]);
    assert.deepEqual(await readBookings(client, rules, THURSDAY), [
      { date: THURSDAY, start: 18 * 60 + 30, party: 2, tables: ["5"], row: 2 },
      { date: THURSDAY, start: 18 * 60 + 30, party: 2, tables: ["7"], row: 3, check: "ORDER" },
    ]);
  });

  test("rows that are cancelled or have left hold nothing", async () => {
    const { client } = sheet([row({ 10: "cancelled" }), row({ 10: "left" }), row({ 10: "Left" })]);
    assert.deepEqual(await readBookings(client, rules, THURSDAY), []);
  });
});

describe("appendBooking", () => {
  const booking: NewBooking = {
    date: THURSDAY,
    start: 19 * 60,
    party: 4,
    tables: ["7", "8"],
    name: "Ada",
    method: "Text (SMS)",
    contact: "5550100",
    notes: "",
    newsletter: false,
  };

  test("appends under the table the header heads, then checkboxes the row it wrote", async () => {
    const { client, writes } = sheet([], false, () => "Tracker!A33:M33");
    await appendBooking(client, booking, rules);
    const [append, checkboxes] = writes();
    assert.match(append.path, /^\/values\/Tracker!A1:M1:append\?/);
    assert.equal(append.body.range, "Tracker!A1:M1");
    const { startRowIndex, endRowIndex } = checkboxes.body.requests[0].setDataValidation.range;
    assert.deepEqual([startRowIndex, endRowIndex], [32, 33]);
  });

  test("rejects when Sheets doesn't say where the row went", async () => {
    const { client, writes } = sheet([], false, () => "");
    await assert.rejects(appendBooking(client, booking, rules), /didn't confirm writing 1 row/);
    assert.equal(writes().length, 1);
  });

  test("rejects when Sheets reports writing a different number of rows", async () => {
    const { client } = sheet([], false, () => "Tracker!A33:M34");
    await assert.rejects(appendBooking(client, booking, rules), /didn't confirm writing 1 row/);
  });

  test("rejects when the write itself fails", async () => {
    const { client } = sheet([], true);
    await assert.rejects(appendBooking(client, booking, rules), /Sheets is down/);
  });
});
