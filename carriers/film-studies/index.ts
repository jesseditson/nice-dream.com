/**
 * Film Studies tickets — https://<site>/carriers/film-studies
 *
 *   GET ?film=   whether the film is on sale, and how many guests it can
 *                still take (`spots_left`, null without a limit)
 *   POST (JSON)  { film: "footprints", tickets: { <ticket index>: quantity },
 *                  donation, name, email, phone } — starts a checkout in the
 *                site's connected payment account and answers with its URL
 *
 * The tickets live on the film_studies object. Each checkout is kept in the
 * site's database with the guest's details, and each ticket is one guest:
 * paid checkouts, and ones started in the last HOLD_MINUTES, are counted
 * against film_studies.max_guests before a checkout starts.
 *
 * Anything the guest can fix comes back as `{ ok: false, error }` with a 200 so
 * the form can show it.
 */
import type { Carrier, CarrierJsonValue, CarrierOutOfStockError, CarrierSite } from "@archival/carrier";
import { filmCheckouts, recordCheckout } from "./checkouts.ts";
import {
  type Menu,
  checkoutItems,
  describeSelection,
  e164,
  findFilm,
  guestsHeld,
  isOnSale,
  latestFilm,
  localStamp,
  parseSelection,
  readMenu,
  spotsLeft,
  spotsRefusal,
  ticketCount,
} from "./order.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTACT_EMAIL = "hello@nice-dream.com";

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";

type Reply = { [key: string]: CarrierJsonValue };

const refuse = (error: string): Reply => ({ ok: false, error });

/** Spots the screening has left, null without a limit; throws when the database can't be read. */
const remainingSpots = async (site: CarrierSite, menu: Menu, film: string): Promise<number | null> => {
  if (menu.maxGuests == null) return null;
  return spotsLeft(menu, guestsHeld(await filmCheckouts(site.sql, site.payments, film)));
};

/** 144 random bits, URL-safe. */
const randomToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const outOfStock = (error: unknown): string[] => {
  const short = (error as Partial<CarrierOutOfStockError> | null)?.outOfStock;
  return Array.isArray(short) ? short : [];
};

const carrier: Carrier = async (params, body, objects, site) => {
  const menu = readMenu(objects.film_studies);
  const fields =
    body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;

  const films = objects.film ?? [];
  const film = findFilm(films, text(fields ? fields.film : params.get("film")));
  if (!film || !localStamp(film.starts)) {
    return refuse("We couldn't find that screening — refresh the page and try again.");
  }

  if (!fields) {
    const onSale = isOnSale(film);
    const left = onSale
      ? await remainingSpots(site, menu, film.path).catch((error) => {
          console.error("Could not count Film Studies guests:", error);
          return null;
        })
      : null;
    return { ok: true, on_sale: onSale, max_guests: menu.maxGuests, spots_left: left };
  }

  if (!isOnSale(film)) {
    return refuse("Online tickets for this screening are closed.");
  }

  const selection = parseSelection(fields, menu);
  if ("error" in selection) return refuse(selection.error);

  const name = text(fields.name);
  if (!name) return refuse("Please tell us your name.");
  const email = text(fields.email);
  if (!EMAIL_RE.test(email)) return refuse("That email address doesn't look right.");
  const phone = e164(text(fields.phone));
  if (!phone) return refuse("That phone number doesn't look right.");

  const guests = ticketCount(selection);
  if (guests > 0 && menu.maxGuests != null) {
    let left: number | null;
    try {
      left = await remainingSpots(site, menu, film.path);
    } catch (error) {
      console.error("Could not count Film Studies guests:", error);
      return refuse("We couldn't check how many spots are left — please try again in a moment.");
    }
    if (left != null && guests > left) return { ...refuse(spotsRefusal(left)), spots_left: left };
  }

  const title = text(film.title) || "Film Studies";
  const summary = describeSelection(menu, selection);
  const siteUrl = site.url.replace(/\/+$/, "");
  const page = latestFilm(films)?.path === film.path ? "/film-studies" : `/${film.path}`;
  const token = randomToken();

  let checkout: { id: string; url: string };
  try {
    checkout = await site.payments.checkout.create({
      items: checkoutItems(menu, selection),
      successUrl: `${siteUrl}${page}?paid=${encodeURIComponent(token)}`,
      cancelUrl: `${siteUrl}${page}`,
      customerEmail: email,
      metadata: { film: title.slice(0, 255), guest: name.slice(0, 255), phone, order: summary.slice(0, 255) },
      idempotencyKey: token,
    });
  } catch (error) {
    if (outOfStock(error).length) return { ...refuse(spotsRefusal(0)), spots_left: 0 };
    console.error("Could not start a Film Studies checkout:", error);
    return refuse(`We couldn't start checkout just now — please try again, or email us at ${CONTACT_EMAIL}.`);
  }

  try {
    await recordCheckout(site.sql, { id: checkout.id, film: film.path, guests, summary, name, email, phone });
  } catch (error) {
    console.error(`Could not record Film Studies checkout ${checkout.id}:`, error);
  }

  return { ok: true, checkout_url: checkout.url };
};

export default carrier;
