import assert from "node:assert/strict";
import { test } from "node:test";
import type { PiePreorderObject } from "./archival-objects.d.ts";
import {
  type Selection,
  describeSelection,
  e164,
  isOpen,
  lineItems,
  localInstant,
  parseSelection,
  pickupTimes,
  readMenu,
} from "./menu.ts";
import { type OrderRow, STATUS, piesBySlot, rowsToSync, statusFrom } from "./sheet.ts";
import { createCheckout } from "./square.ts";

const object: PiePreorderObject = {
  path: "pies.toml",
  order: null,
  title: "Thanksgiving Pies",
  blurb: null,
  blurb_note: null,
  orders_close: "2026-11-21 23:59",
  slot_minutes: 30,
  pies_per_slot: 4,
  max_per_order: 6,
  add_on_name: "Pint",
  add_on_price: 13,
  add_on_modifier_id: "MOD",
  square_location_id: "LOC",
  orders_sheet_id: "sheet",
  pies: [
    { name: "Basque", description: null, price: 60, square_variation_id: "BASQUE" },
    { name: "Crumble", description: null, price: 60, square_variation_id: "CRUMBLE" },
    { name: "Unlisted", description: null, price: 60, square_variation_id: "" },
  ],
  pickup_windows: [
    { date: "2026-11-25", first: "12:00", last: "13:00" },
    { date: "bad", first: "12:00", last: "13:00" },
  ],
};

const menu = readMenu(object);

const selection = (pies: Record<string, number>, addOns = 0): Selection => ({
  pies: new Map(Object.entries(pies)),
  addOns,
});

test("reads only pies with a variation and windows with a valid date", () => {
  assert.deepEqual(menu.pies.map((pie) => pie.id), ["BASQUE", "CRUMBLE"]);
  assert.deepEqual(menu.windows, [{ date: "2026-11-25", first: 720, last: 780 }]);
  assert.deepEqual(pickupTimes(menu, "2026-11-25"), [720, 750, 780]);
});

test("closes at orders_close in Pacific time", () => {
  assert.equal(isOpen(menu, new Date("2026-11-22T07:58:00Z")), true);
  assert.equal(isOpen(menu, new Date("2026-11-22T08:00:00Z")), false);
});

test("pickup times become the right instant on either side of daylight saving", () => {
  assert.equal(localInstant("2026-11-25", 750).toISOString(), "2026-11-25T20:30:00.000Z");
  assert.equal(localInstant("2026-07-01", 750).toISOString(), "2026-07-01T19:30:00.000Z");
});

test("add-ons ride on as many pies as asked, splitting a line when needed", () => {
  assert.deepEqual(lineItems(menu, selection({ BASQUE: 2, CRUMBLE: 1 }, 3)), [
    { catalog_object_id: "BASQUE", quantity: "2", modifiers: [{ catalog_object_id: "MOD" }] },
    { catalog_object_id: "CRUMBLE", quantity: "1", modifiers: [{ catalog_object_id: "MOD" }] },
  ]);
  assert.deepEqual(lineItems(menu, selection({ BASQUE: 3 }, 1)), [
    { catalog_object_id: "BASQUE", quantity: "1", modifiers: [{ catalog_object_id: "MOD" }] },
    { catalog_object_id: "BASQUE", quantity: "2" },
  ]);
  assert.equal(describeSelection(menu, selection({ BASQUE: 3 }, 1)), "3 × Basque + 1 × Pint");
});

test("refuses empty, oversized and unknown orders, and more add-ons than pies", () => {
  assert.ok("error" in parseSelection({ pies: {} }, menu));
  assert.ok("error" in parseSelection({ pies: { BASQUE: 7 } }, menu));
  assert.ok("error" in parseSelection({ pies: { NOPE: 1 } }, menu));
  assert.ok("error" in parseSelection({ pies: { BASQUE: 1 }, add_ons: 2 }, menu));
  const parsed = parseSelection({ pies: { BASQUE: "2", CRUMBLE: 0 }, add_ons: 1 }, menu);
  assert.ok(!("error" in parsed));
  assert.deepEqual([...parsed.pies], [["BASQUE", 2]]);
});

test("phone numbers become E.164", () => {
  assert.equal(e164("(760) 239-7919"), "+17602397919");
  assert.equal(e164("1 760 239 7919"), "+17602397919");
  assert.equal(e164("+44 20 7946 0958"), "+442079460958");
  assert.equal(e164("239-7919"), null);
});

const row = (overrides: Partial<OrderRow>): OrderRow => ({
  row: 2,
  date: "2026-11-25",
  start: 720,
  name: "Ada",
  status: STATUS.paid,
  summary: "",
  orderedAt: "2026-11-01 10:00",
  squareOrder: "ORDER",
  checkout: "",
  token: "tok",
  pies: 1,
  ...overrides,
});

test("unpaid checkouts hold their pies for a while, then let them go", () => {
  const created = new Date("2026-11-01T18:00:00Z");
  const draft = { state: "DRAFT", createdAt: created, total: null };
  assert.equal(statusFrom(STATUS.awaiting, draft, new Date("2026-11-01T18:20:00Z")), null);
  assert.equal(statusFrom(STATUS.awaiting, draft, new Date("2026-11-01T18:31:00Z")), STATUS.notPaid);
  assert.equal(statusFrom(STATUS.notPaid, { ...draft, state: "OPEN" }), STATUS.paid);
  assert.equal(statusFrom(STATUS.paid, { ...draft, state: "COMPLETED" }), null);
  assert.equal(statusFrom(STATUS.paid, { ...draft, state: "CANCELED" }), STATUS.cancelled);

  const taken = piesBySlot([
    row({ pies: 2 }),
    row({ status: STATUS.awaiting }),
    row({ status: "" }),
    row({ status: STATUS.notPaid, pies: 5 }),
    row({ status: STATUS.cancelled, pies: 5 }),
  ]);
  assert.equal(taken.get("2026-11-25 12:00"), 4);
});

test("looks up recent unpaid checkouts, and the guest's own at any age", () => {
  const now = new Date("2026-11-05T18:00:00Z");
  const orders = [
    row({ token: "a", status: STATUS.awaiting }),
    row({ token: "b", status: STATUS.notPaid, orderedAt: "2026-11-05 08:00" }),
    row({ token: "c", status: STATUS.notPaid }),
    row({ token: "d", status: STATUS.paid }),
    row({ token: "e", status: STATUS.awaiting, squareOrder: "" }),
  ];
  assert.deepEqual(rowsToSync(orders, "", now).map((order) => order.token), ["a", "b"]);
  assert.deepEqual(rowsToSync(orders, "c", now).map((order) => order.token), ["a", "b", "c"]);
});

test("the checkout's Square order carries a scheduled pickup and the guest's details", async () => {
  let sent: Record<string, any> = {};
  const fetcher = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ payment_link: { url: "https://square.link/u/x", order_id: "O1" } }));
  }) as typeof fetch;
  const checkout = await createCheckout(
    "token",
    {
      token: "tok",
      locationId: "LOC",
      lineItems: [],
      pickupAt: localInstant("2026-11-25", 750),
      name: "Ada",
      email: "ada@example.com",
      phone: "+17602397919",
      note: "",
      redirectUrl: "https://nice-dream.com/pie-preorder.html?order=tok",
    },
    fetcher,
  );
  assert.deepEqual(checkout, { url: "https://square.link/u/x", orderId: "O1" });
  assert.equal(sent.order.reference_id, "tok");
  const pickup = sent.order.fulfillments[0].pickup_details;
  assert.equal(pickup.schedule_type, "SCHEDULED");
  assert.equal(pickup.pickup_at, "2026-11-25T20:30:00.000Z");
  assert.equal(pickup.recipient.display_name, "Ada");
  assert.equal(sent.checkout_options.redirect_url, "https://nice-dream.com/pie-preorder.html?order=tok");
});
