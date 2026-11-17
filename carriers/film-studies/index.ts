/**
 * Film Studies drink tickets — https://<site>/carriers/film-studies
 *
 *   GET ?film=   whether the film is on sale, and how many guests it can
 *                still take (`spots_left`, null without a limit)
 *   POST (JSON)  { film: "footprints", tickets: { <ticket index>: quantity },
 *                  donation, name, email, phone } — starts a Square checkout
 *                and answers with its URL
 *
 * The tickets and Square location live on the film_studies object; the Square
 * access token is the one the dinner object already holds. The order itself is
 * the record: it lands in Square with the guest's name and a pickup at the
 * screening's start. Each drink ticket is one guest, and Square's orders are
 * counted against film_studies.max_guests before a checkout starts.
 *
 * Anything the guest can fix comes back as `{ ok: false, error }` with a 200 so
 * the form can show it; only a misconfigured site throws.
 */
import type { Carrier, CarrierJsonValue } from "@archival/carrier";
import {
  type Menu,
  describeSelection,
  e164,
  findFilm,
  guestsTaken,
  isOnSale,
  latestFilm,
  lineItems,
  localInstant,
  localStamp,
  parseSelection,
  readMenu,
  spotsLeft,
  spotsRefusal,
  ticketCount,
} from "./order.ts";
import { createCheckout, pickupOrders } from "./square.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTACT_EMAIL = "hello@nice-dream.com";

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";

type Reply = { [key: string]: CarrierJsonValue };

const refuse = (error: string): Reply => ({ ok: false, error });

/** How far back Square is searched for a screening's orders. */
const LOOKBACK_DAYS = 90;

/** Spots the screening has left, null without a limit; throws when Square can't be reached. */
const remainingSpots = async (token: string, menu: Menu, screeningAt: Date): Promise<number | null> => {
  if (menu.maxGuests == null) return null;
  const orders = await pickupOrders(token, menu.locationId, new Date(Date.now() - LOOKBACK_DAYS * 86_400_000));
  return spotsLeft(menu, guestsTaken(menu, orders, screeningAt));
};

/** 144 random bits, URL-safe, and short enough for Square's reference_id. */
const randomToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const carrier: Carrier = async (params, body, objects) => {
  const menu = readMenu(objects.film_studies);
  const squareToken = objects.dinner.square_access_token;
  if (!squareToken || !menu.locationId) {
    throw new Error(
      "Film Studies tickets are not configured — set square_location_id on the film_studies object and square_access_token on the dinner object.",
    );
  }
  const fields =
    body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;

  const films = objects.film ?? [];
  const film = findFilm(films, text(fields ? fields.film : params.get("film")));
  const stamp = film ? localStamp(film.starts) : null;
  if (!film || !stamp) return refuse("We couldn't find that screening — refresh the page and try again.");
  const screeningAt = localInstant(stamp);

  if (!fields) {
    const onSale = isOnSale(film);
    const left = onSale
      ? await remainingSpots(squareToken, menu, screeningAt).catch((error) => {
          console.error("Could not count Film Studies guests:", error);
          return null;
        })
      : null;
    return { ok: true, on_sale: onSale, max_guests: menu.maxGuests, spots_left: left };
  }

  if (!isOnSale(film)) {
    return refuse("Online drink tickets for this screening are closed — come grab a drink at the bar!");
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
      left = await remainingSpots(squareToken, menu, screeningAt);
    } catch (error) {
      console.error("Could not count Film Studies guests:", error);
      return refuse("We couldn't check how many spots are left — please try again in a moment.");
    }
    if (left != null && guests > left) return { ...refuse(spotsRefusal(left)), spots_left: left };
  }

  const title = text(film.title) || "Film Studies";
  const siteUrl = (objects.SITE_URL || "https://nice-dream.com").replace(/\/+$/, "");
  const page = latestFilm(films)?.path === film.path ? "/film-studies" : `/${film.path}`;
  const token = randomToken();

  try {
    const checkout = await createCheckout(squareToken, {
      token,
      locationId: menu.locationId,
      lineItems: lineItems(menu, selection, title),
      screeningAt,
      name,
      email,
      phone,
      note: `Film Studies: ${title} — ${describeSelection(menu, selection)}`,
      allowTipping: guests > 0,
      redirectUrl: `${siteUrl}${page}?paid=${encodeURIComponent(token)}`,
    });
    return { ok: true, checkout_url: checkout.url };
  } catch (error) {
    console.error("Could not start a Square checkout:", error);
    return refuse(`We couldn't start checkout just now — please try again, or email us at ${CONTACT_EMAIL}.`);
  }
};

export default carrier;
