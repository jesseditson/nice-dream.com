import assert from "node:assert/strict";
import { test } from "node:test";
import type { FilmObject, FilmStudiesObject } from "./archival-objects.d.ts";
import {
  checkoutItems,
  describeSelection,
  findFilm,
  guestsHeld,
  isOnSale,
  latestFilm,
  localInstant,
  localStamp,
  parseDollars,
  parseSelection,
  readMenu,
  spotsLeft,
  spotsRefusal,
} from "./order.ts";

const studies: FilmStudiesObject = {
  path: "film_studies.toml",
  order: null,
  about: null,
  about_host: null,
  max_per_ticket: 4,
  max_guests: 50,
  donation_title: null,
  donation_description: null,
  ticket: [
    { name: "Admission", description: null, price: 15, variant_id: "" },
    { name: "Unpriced", description: null, price: null, variant_id: "" },
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
    [true, false],
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
    tickets: [2, 0],
    donationCents: 1000,
  });
  assert.deepEqual(parseSelection({ donation: "5" }, menu), { tickets: [0, 0], donationCents: 500 });
  assert.ok("error" in parseSelection({ tickets: {}, donation: "" }, menu));
  assert.ok("error" in parseSelection({ tickets: { 0: 5 } }, menu));
  assert.ok("error" in parseSelection({ tickets: { 0: 1.5 } }, menu));
  assert.ok("error" in parseSelection({ tickets: { 7: 1 } }, menu));
  assert.ok("error" in parseSelection({ tickets: { 1: 1 } }, menu));
  assert.ok("error" in parseSelection({ donation: "0.50" }, menu));
});

test("checkoutItems sell variants where set, and price the rest here", () => {
  const menu = readMenu(studies);
  const selection = { tickets: [2, 0], donationCents: 2000 };
  assert.deepEqual(checkoutItems(menu, selection), [
    { name: "Admission", amount: 1500, quantity: 2 },
    { name: "Tip Your Professor", amount: 2000, quantity: 1 },
  ]);
  assert.deepEqual(checkoutItems(menu, { tickets: [0, 0], donationCents: 500 }), [
    { name: "Tip Your Professor", amount: 500, quantity: 1 },
  ]);
  const sold = readMenu({ ...studies, ticket: [{ ...studies.ticket[0], variant_id: "VAR" }] });
  assert.deepEqual(checkoutItems(sold, { tickets: [2], donationCents: 0 }), [{ variant: "VAR", quantity: 2 }]);
  assert.deepEqual(checkoutItems(sold, { tickets: [2], donationCents: 500 }, "Footprints · Ada").map((item) => item.note), [
    "Footprints · Ada",
    undefined,
  ]);
  assert.equal(describeSelection(menu, selection), "2 Admissions, a $20 tip");
});

test("guestsHeld counts paid checkouts and fresh open ones", () => {
  const menu = readMenu(studies);
  const now = Date.parse("2026-11-20T20:00:00Z");
  const checkout = (status: string, minutesAgo: number, guests: number) => ({
    status,
    guests,
    createdAt: now - minutesAgo * 60_000,
  });
  const taken = guestsHeld(
    [
      checkout("paid", 600, 3),
      checkout("paid", 900, 2),
      checkout("open", 5, 4),
      checkout("open", 45, 4),
      checkout("canceled", 5, 4),
      checkout("expired", 5, 4),
      checkout("paid", 10, 0),
    ],
    now,
  );
  assert.equal(taken, 3 + 2 + 4);
  assert.equal(spotsLeft(menu, taken), 41);
  assert.equal(spotsLeft(menu, 60), 0);
  assert.equal(spotsLeft(readMenu({ ...studies, max_guests: null }), 60), null);
  assert.match(spotsRefusal(0), /sold out/);
  assert.equal(spotsRefusal(1), "Only 1 ticket left.");
});
