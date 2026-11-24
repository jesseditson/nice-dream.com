import assert from "node:assert/strict";
import { test } from "node:test";
import type { CarrierCheckout, CarrierPayments } from "@archival/carrier";
import type { PiePreorderObject } from "./archival-objects.d.ts";
import {
  type Selection,
  checkoutItems,
  describeSelection,
  e164,
  isOpen,
  localInstant,
  parseSelection,
  pickupTimes,
  readMenu,
} from "./menu.ts";
import { RECHECK_MINUTES, checkoutStates, isDue } from "./payments.ts";
import {
  CHECKOUTS,
  COL,
  type OrderRow,
  STATUS,
  UNSCHEDULED,
  appendOrders,
  applyStates,
  paidOrders,
  readOrders,
  rowsToSync,
  statusFrom,
} from "./sheet.ts";
import type { SheetsClient } from "./google.ts";

const object: PiePreorderObject = {
  path: "pies.toml",
  order: null,
  title: "Thanksgiving Pies",
  blurb: null,
  blurb_note: null,
  orders_close: "2026-11-21 23:59",
  slot_minutes: 30,
  max_per_order: 6,
  add_on_name: "Pint",
  add_on_price: 13,
  orders_sheet_id: "sheet",
  pies: [
    { name: "Basque", description: null, price: 60, variant_id: "BASQUE" },
    { name: "Crumble", description: null, price: 60, variant_id: "CRUMBLE" },
    { name: "Unlisted", description: null, price: 60, variant_id: "" },
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

test("reads only pies with a variant and windows with a valid date", () => {
  assert.deepEqual(menu.pies.map((pie) => pie.id), ["BASQUE", "CRUMBLE"]);
  assert.deepEqual(menu.addOn, { name: "Pint", price: 13 });
  assert.equal(readMenu({ ...object, add_on_price: null }).addOn, null);
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

test("pies check out as their variants, and the add-ons as one line priced here", () => {
  assert.deepEqual(checkoutItems(menu, selection({ BASQUE: 2, CRUMBLE: 1 }, 3)), [
    { variant: "BASQUE", quantity: 2 },
    { variant: "CRUMBLE", quantity: 1 },
    { name: "Pint", amount: 1300, quantity: 3 },
  ]);
  assert.deepEqual(checkoutItems(menu, selection({ BASQUE: 3 })), [{ variant: "BASQUE", quantity: 3 }]);
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
  summary: "2 × Basque + 1 × Pint",
  phone: "+17602397919",
  email: "ada@example.com",
  notes: "",
  total: "",
  orderedAt: "2026-11-01 10:00",
  checkoutId: "co_1",
  checkout: "https://square.link/u/x",
  token: "tok",
  selection: selection({ BASQUE: 2, CRUMBLE: 0 }, 1),
  ...overrides,
});

const checkout = (status: CarrierCheckout["status"], amountTotal: number | null = null): CarrierCheckout => ({
  id: "co_1",
  status,
  amountTotal,
  currency: "usd",
  customerEmail: null,
});

test("a checkout left open for half an hour is marked not paid, and paid if it's paid later", () => {
  const ordered = new Date("2026-11-01T18:00:00Z");
  assert.equal(statusFrom(STATUS.awaiting, "open", ordered, new Date("2026-11-01T18:20:00Z")), null);
  assert.equal(statusFrom(STATUS.awaiting, "open", ordered, new Date("2026-11-01T18:31:00Z")), STATUS.notPaid);
  assert.equal(statusFrom(STATUS.notPaid, "paid", ordered), STATUS.paid);
  assert.equal(statusFrom(STATUS.paid, "paid", ordered), null);
  assert.equal(statusFrom(STATUS.paid, "canceled", ordered), STATUS.cancelled);
  assert.equal(statusFrom(STATUS.awaiting, "expired", ordered), STATUS.notPaid);
});

test("looks up recent unpaid checkouts, and the guest's own at any age", () => {
  const now = new Date("2026-11-05T18:00:00Z");
  const orders = [
    row({ token: "a", status: STATUS.awaiting }),
    row({ token: "b", status: STATUS.notPaid, orderedAt: "2026-11-05 08:00" }),
    row({ token: "c", status: STATUS.notPaid }),
    row({ token: "d", status: STATUS.paid }),
    row({ token: "e", status: STATUS.awaiting, checkoutId: "" }),
  ];
  assert.deepEqual(rowsToSync(orders, "", now).map((order) => order.token), ["a", "b"]);
  assert.deepEqual(rowsToSync(orders, "c", now).map((order) => order.token), ["a", "b", "c"]);
});

test("a paid checkout's status and total are written to its row", async () => {
  let sent: Record<string, any> = {};
  const client = (async (_method: string, _url: string, body: unknown) => {
    sent = body as Record<string, any>;
    return {};
  }) as SheetsClient;
  const rows = [row({ row: 7, status: STATUS.awaiting }), row({ row: 8, status: STATUS.awaiting, checkoutId: "co_2" })];
  await applyStates(client, rows, new Map([["co_1", checkout("paid", 13304)]]), new Date("2026-11-01T18:10:00Z"));
  assert.deepEqual(sent.data, [
    { range: "Checkouts!D7", values: [[STATUS.paid]] },
    { range: "Checkouts!J7", values: [["$133.04"]] },
  ]);
  assert.equal(rows[0].total, "$133.04");
  assert.equal(rows[1].status, STATUS.awaiting);
});

test("paid checkouts not yet on the Orders tab become Orders rows", () => {
  const rows = [
    row({ checkoutId: "co_1", total: "$133.04" }),
    row({ checkoutId: "co_2", status: STATUS.awaiting }),
    row({ checkoutId: "co_3" }),
  ];
  const found = paidOrders(rows, new Set(["co_3"]));
  assert.equal(found.length, 1);
  assert.equal(found[0].checkoutId, "co_1");
  assert.equal(found[0].total, "$133.04");
  assert.equal(found[0].start, 720);
  assert.deepEqual([...found[0].selection.pies], [["BASQUE", 2], ["CRUMBLE", 0]]);
  assert.equal(paidOrders(rows, new Set(["co_1", "co_3"])).length, 0);
});

test("rows read back with their pie counts", async () => {
  const cells: unknown[] = [];
  cells[COL.date] = 46351;
  cells[COL.time] = "2:00 PM";
  cells[COL.status] = "Paid";
  cells[COL.checkoutId] = "co_9";
  cells[COL.counts] = 2;
  cells[COL.counts + 1] = "";
  cells[COL.counts + 2] = 1;
  const client = (async () => ({ values: [cells] })) as SheetsClient;
  const [read] = await readOrders(client, menu, CHECKOUTS);
  assert.equal(read.date, "2026-11-25");
  assert.equal(read.start, 840);
  assert.equal(read.status, STATUS.paid);
  assert.equal(read.checkoutId, "co_9");
  assert.deepEqual([...read.selection.pies], [["BASQUE", 2], ["CRUMBLE", 0]]);
  assert.equal(read.selection.addOns, 1);
});

test("checkouts are asked about once each, and not again for a few minutes", async () => {
  const asked: string[] = [];
  const payments = {
    checkout: {
      get: async (id: string) => {
        asked.push(id);
        if (id === "co_gone") throw new Error("That is not a checkout this site made");
        return { ...checkout("paid"), id };
      },
    },
  } as unknown as CarrierPayments;
  const now = Date.parse("2026-11-20T20:00:00Z");
  const states = await checkoutStates(payments, ["co_a", "co_gone"], now);
  assert.deepEqual([...states.keys()], ["co_a"]);
  assert.deepEqual(asked, ["co_a", "co_gone"]);
  assert.equal(isDue("co_a", now + (RECHECK_MINUTES - 1) * 60_000), false);
  assert.equal(isDue("co_gone", now + RECHECK_MINUTES * 60_000), true);
  assert.equal(isDue("co_never", now), true);
});

test("a row's pickup time is written as a clock time, or unscheduled", async () => {
  let path = "";
  let sent: Record<string, any> = {};
  const client = (async (_method: string, url: string, body: unknown) => {
    path = url;
    sent = body as Record<string, any>;
    return {};
  }) as SheetsClient;
  const [found] = paidOrders([row({})], new Set());
  await appendOrders(client, menu, CHECKOUTS, [{ ...found, start: 840 }, { ...found, start: null }]);
  assert.match(decodeURIComponent(path), /^\/values\/Checkouts!A1:/);
  assert.deepEqual(
    sent.values.map((cells: unknown[]) => cells[COL.time]),
    ["2:00 PM", UNSCHEDULED],
  );
  assert.equal(sent.values[0][COL.checkoutId], "co_1");
  assert.deepEqual(sent.values[0].slice(COL.counts), [2, 0, 1]);
});
