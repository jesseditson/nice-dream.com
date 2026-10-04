import assert from "node:assert/strict";
import { afterEach, describe, mock, test } from "node:test";
import { openTickets } from "./square.ts";

const PACIFIC = "America/Los_Angeles";

type Sent = { url: string; headers: Record<string, string>; body: any };

/** Stands in for Square: answers every search with `status` and `payload`, and records what was sent. */
const square = (payload: unknown, status = 200): Sent[] => {
  const sent: Sent[] = [];
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    sent.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify(payload), { status });
  });
  return sent;
};

describe("openTickets", () => {
  afterEach(() => mock.restoreAll());

  test("asks Square for the location's open orders from the last few hours, oldest first", async () => {
    const sent = square({});
    const before = Date.now();
    await openTickets("token", "LOCATION", PACIFIC);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "https://connect.squareup.com/v2/orders/search");
    assert.equal(sent[0].headers.authorization, "Bearer token");
    assert.deepEqual(sent[0].body.location_ids, ["LOCATION"]);
    assert.deepEqual(sent[0].body.query.filter.state_filter, { states: ["OPEN"] });
    assert.deepEqual(sent[0].body.query.sort, { sort_field: "CREATED_AT", sort_order: "ASC" });
    const since = Date.parse(sent[0].body.query.filter.date_time_filter.created_at.start_at);
    const twelveHours = 12 * 60 * 60 * 1000;
    assert.ok(since >= before - twelveHours && since <= Date.now() - twelveHours);
  });

  test("gives each named check its ticket name and when it opened, in the restaurant's time", async () => {
    square({
      orders: [
        { id: "A", ticket_name: "* 5", created_at: "2026-10-09T01:42:10.000Z" },
        { id: "B", ticket_name: "Bar 1", created_at: "2026-10-09T07:05:00.000Z" },
      ],
    });
    assert.deepEqual(await openTickets("token", "LOCATION", PACIFIC), [
      { id: "A", name: "* 5", date: "2026-10-08", start: 18 * 60 + 42 },
      { id: "B", name: "Bar 1", date: "2026-10-09", start: 5 },
    ]);
  });

  test("skips orders with no ticket name or no opening time", async () => {
    square({ orders: [{ id: "A", created_at: "2026-10-09T01:42:10.000Z" }, { id: "B", ticket_name: "* 5" }] });
    assert.deepEqual(await openTickets("token", "LOCATION", PACIFIC), []);
  });

  test("answers with nothing when Square has no open orders", async () => {
    square({});
    assert.deepEqual(await openTickets("token", "LOCATION", PACIFIC), []);
  });

  test("answers null, rather than failing the form, when Square refuses or is down", async () => {
    mock.method(console, "error", () => {});
    square({ errors: [{ code: "UNAUTHORIZED" }] }, 401);
    assert.equal(await openTickets("token", "LOCATION", PACIFIC), null);

    mock.method(globalThis, "fetch", async () => {
      throw new Error("network down");
    });
    assert.equal(await openTickets("token", "LOCATION", PACIFIC), null);
  });
});
