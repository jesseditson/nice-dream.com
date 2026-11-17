import assert from "node:assert/strict";
import { test } from "node:test";
import type { FilmObject, FilmStudiesObject } from "./archival-objects.d.ts";
import {
  describeSelection,
  type FilmOrder,
  findFilm,
  guestsTaken,
  isOnSale,
  latestFilm,
  lineItems,
  localInstant,
  localStamp,
  parseDollars,
  parseSelection,
  readMenu,
  spotsLeft,
  spotsRefusal,
} from "./order.ts";
import { createCheckout, pickupOrders } from "./square.ts";

const studies: FilmStudiesObject = {
  path: "film_studies.toml",
  order: null,
  about: null,
  about_host: null,
  max_per_ticket: 4,
  max_guests: 50,
  donation_title: null,
  donation_description: null,
  donation_variation_id: "",
  square_location_id: "LOC",
  ticket: [
    { name: "Single Drink Ticket", description: null, price: 15, square_variation_id: "" },
    { name: "Double Drink Ticket", description: null, price: 28, square_variation_id: "VAR2" },
    { name: "Unpriced", description: null, price: null, square_variation_id: "" },
  ],
};

const film = (path: string, starts: string): FilmObject => ({
  path,
  order: null,
  title: "Footprints on the Moon",
  also_known_as: null,
  starts,
  poster: null,
  poster_alt: null,
  synopsis: null,
  programmer_note: null,
  trailer_youtube: null,
  trailer: null,
  trailer_still: null,
  info: [],
  reading: [],
  scene: [],
});

test("readMenu keeps every ticket's position, and only sells priced ones", () => {
  const menu = readMenu(studies);
  assert.deepEqual(
    menu.tickets.map((ticket) => ticket.available),
    [true, true, false],
  );
  assert.equal(menu.maxPerTicket, 4);
  assert.equal(menu.maxGuests, 50);
  assert.equal(readMenu({ ...studies, max_guests: null }).maxGuests, null);
  assert.equal(readMenu({ ...studies, max_guests: 0 }).maxGuests, null);
});

test("localStamp reads archival's date shapes", () => {
  assert.equal(localStamp("2026-12-01 18:00:00"), "2026-12-01 18:00");
  assert.equal(localStamp("2026-12-01T18:00:00.0"), "2026-12-01 18:00");
  assert.equal(localStamp("2026-12-01"), "2026-12-01 00:00");
  assert.equal(localStamp(""), null);
});

test("localInstant is Yucca Valley wall time", () => {
  assert.equal(localInstant("2026-12-01 18:00").toISOString(), "2026-12-02T02:00:00.000Z");
  assert.equal(localInstant("2026-07-01 18:00").toISOString(), "2026-07-02T01:00:00.000Z");
});

test("tickets are on sale until the screening starts", () => {
  const screening = film("film/footprints", "2026-12-01 18:00:00");
  assert.equal(isOnSale(screening, new Date("2026-12-02T01:59:00Z")), true);
  assert.equal(isOnSale(screening, new Date("2026-12-02T02:00:00Z")), false);
});

test("findFilm and latestFilm", () => {
  const films = [film("film/footprints", "2026-12-01 18:00:00"), film("film/older", "2026-11-03 18:00:00")];
  assert.equal(findFilm(films, "footprints")?.path, "film/footprints");
  assert.equal(findFilm(films, "film/older")?.path, "film/older");
  assert.equal(findFilm(films, "../dinner"), null);
  assert.equal(latestFilm(films)?.path, "film/footprints");
});

test("parseDollars", () => {
  assert.equal(parseDollars("20"), 2000);
  assert.equal(parseDollars("$12.5"), 1250);
  assert.equal(parseDollars(""), 0);
  assert.equal(parseDollars("-5"), null);
  assert.equal(parseDollars("1e3"), null);
});

test("parseSelection", () => {
  const menu = readMenu(studies);
  assert.deepEqual(parseSelection({ tickets: { 0: 2 }, donation: "10" }, menu), {
    tickets: [2, 0, 0],
    donationCents: 1000,
  });
  assert.deepEqual(parseSelection({ donation: "5" }, menu), { tickets: [0, 0, 0], donationCents: 500 });
  assert.ok("error" in parseSelection({ tickets: {}, donation: "" }, menu));
  assert.ok("error" in parseSelection({ tickets: { 0: 5 } }, menu));
  assert.ok("error" in parseSelection({ tickets: { 0: 1.5 } }, menu));
  assert.ok("error" in parseSelection({ tickets: { 7: 1 } }, menu));
  assert.ok("error" in parseSelection({ tickets: { 2: 1 } }, menu));
  assert.ok("error" in parseSelection({ donation: "0.50" }, menu));
});

test("lineItems use the catalog where a variation is set", () => {
  const menu = readMenu(studies);
  const selection = { tickets: [1, 2, 0], donationCents: 2000 };
  assert.deepEqual(lineItems(menu, selection, "Footprints"), [
    {
      name: "Single Drink Ticket",
      quantity: "1",
      base_price_money: { amount: 1500, currency: "USD" },
      note: "Film Studies: Footprints",
    },
    { catalog_object_id: "VAR2", quantity: "2", note: "Film Studies: Footprints" },
    { name: "Donation to Film Studies", quantity: "1", base_price_money: { amount: 2000, currency: "USD" } },
  ]);
  assert.equal(describeSelection(menu, selection), "1 Single Drink Ticket, 2 Double Drink Tickets, a $20 donation");
});

test("createCheckout schedules the pickup at the screening", async () => {
  let sent: Record<string, any> = {};
  const fetcher = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ payment_link: { url: "https://square.link/u/x", order_id: "ORD" } }));
  }) as typeof fetch;
  const checkout = await createCheckout(
    "token",
    {
      token: "abc",
      locationId: "LOC",
      lineItems: [],
      screeningAt: localInstant("2026-12-01 18:00"),
      name: "Ada",
      email: "ada@example.com",
      phone: "+17605550100",
      note: "Film Studies",
      allowTipping: false,
      redirectUrl: "https://nice-dream.com/film-studies?paid=abc",
    },
    fetcher,
  );
  assert.deepEqual(checkout, { url: "https://square.link/u/x", orderId: "ORD" });
  assert.equal(sent.order.reference_id, "abc");
  assert.deepEqual(sent.order.pricing_options, { auto_apply_taxes: true });
  assert.equal(sent.order.fulfillments[0].pickup_details.pickup_at, "2026-12-02T02:00:00.000Z");
  assert.equal(sent.checkout_options.allow_tipping, false);
});

test("guestsTaken counts paid tickets and fresh checkouts for that screening", () => {
  const menu = readMenu(studies);
  const screeningAt = localInstant("2026-12-01 18:00");
  const now = new Date("2026-11-20T20:00:00Z");
  const order = (state: string, minutesAgo: number, items: FilmOrder["line_items"], pickupAt = screeningAt): FilmOrder => ({
    state,
    created_at: new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
    line_items: items,
    fulfillments: [{ type: "PICKUP", pickup_details: { pickup_at: pickupAt.toISOString().replace(".000Z", "Z") } }],
  });
  const orders: FilmOrder[] = [
    order("OPEN", 600, [{ name: "Single Drink Ticket", quantity: "3" }, { name: "Donation to Film Studies", quantity: "1" }]),
    order("COMPLETED", 900, [{ catalog_object_id: "VAR2", quantity: "2" }]),
    order("DRAFT", 5, [{ name: "Single Drink Ticket", quantity: "4" }]),
    order("DRAFT", 45, [{ name: "Single Drink Ticket", quantity: "4" }]),
    order("CANCELED", 60, [{ name: "Single Drink Ticket", quantity: "4" }]),
    order("OPEN", 60, [{ name: "Single Drink Ticket", quantity: "4" }], localInstant("2027-01-05 18:00")),
    order("OPEN", 60, [{ catalog_object_id: "PIE", name: "Single Drink Ticket", quantity: "1" }]),
  ];
  const taken = guestsTaken(menu, orders, screeningAt, now);
  assert.equal(taken, 3 + 2 + 4);
  assert.equal(spotsLeft(menu, taken), 41);
  assert.equal(spotsLeft(menu, 60), 0);
  assert.equal(spotsLeft(readMenu({ ...studies, max_guests: null }), 60), null);
  assert.match(spotsRefusal(0), /sold out/);
  assert.equal(spotsRefusal(1), "Only 1 ticket left.");
});

test("pickupOrders follows Square's cursor and includes checkouts still open", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(body);
    const page = body.cursor ? { orders: [{ state: "DRAFT" }] } : { orders: [{ state: "OPEN" }], cursor: "next" };
    return new Response(JSON.stringify(page), { status: 200 });
  }) as typeof fetch;
  const orders = await pickupOrders("TOKEN", "LOC", new Date("2026-09-01T00:00:00Z"), fetcher);
  assert.deepEqual(
    orders.map((order) => order.state),
    ["OPEN", "DRAFT"],
  );
  assert.equal(bodies.length, 2);
  const filter = (bodies[0].query as { filter: { state_filter: { states: string[] } } }).filter;
  assert.deepEqual(filter.state_filter.states, ["DRAFT", "OPEN", "COMPLETED"]);
});
