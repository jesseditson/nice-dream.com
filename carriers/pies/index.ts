/**
 * Pie pre-orders — https://<site>/carriers/pies
 *
 *   GET             whether orders are open, and every pickup time with how
 *                   many pies it can still take
 *   GET ?order=     the same, plus that order and whether it has been paid
 *   POST (JSON)     { pies: { <variation id>: quantity }, add_ons, date, time,
 *                     name, email, phone, notes? } — starts a Square checkout
 *                     for the order with its pickup time set, logs it to the
 *                     Orders tab, and answers with the checkout's URL
 *
 * Every request also asks Square whether the checkouts still awaiting payment
 * have been paid, and writes the answer to their rows. It also picks up paid
 * pie orders placed through the dashboard checkout link: each gets a row, and
 * its ASAP pickup is moved to the first pickup time (see link.ts).
 *
 * The menu, pickup days and orders spreadsheet live on the pie_preorder
 * object; the Google and Square credentials are the ones the dinner object
 * already holds.
 *
 * Anything the guest can fix comes back as `{ ok: false, error }` with a 200 so
 * the form can show it; only a misconfigured site throws.
 */
import type { Carrier, CarrierJsonValue } from "@archival/carrier";
import { accessToken, sheetsClient } from "./google.ts";
import {
  TIMEZONE,
  describeSelection,
  e164,
  formatClock,
  formatDateLabel,
  formatHHMM,
  isOpen,
  lineItems,
  localInstant,
  parseHHMM,
  parseSelection,
  pickupDates,
  pickupTimes,
  pieCount,
  readMenu,
  timestampIn,
} from "./menu.ts";
import {
  STATUS,
  appendOrders,
  applyStates,
  ensureSheet,
  piesBySlot,
  readOrders,
  rowsToSync,
} from "./sheet.ts";
import { LOOKBACK_DAYS, planFound } from "./link.ts";
import { createCheckout, orderStates, paidPickupOrders, reschedulePickup } from "./square.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTACT_EMAIL = "hello@nice-dream.com";
const FORM_PATH = "/pie-preorder.html";

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";

type Reply = { [key: string]: CarrierJsonValue };

const refuse = (error: string): Reply => ({ ok: false, error });

/** The key in a guest's return link: 144 random bits, URL-safe, and short enough for Square's reference_id. */
const randomToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const carrier: Carrier = async (params, body, objects) => {
  const dinner = objects.dinner;
  const menu = readMenu(objects.pie_preorder);
  if (!dinner.google_service_account || !objects.pie_preorder.orders_sheet_id) {
    throw new Error(
      "Pie orders are not configured — set orders_sheet_id on the pie_preorder object and google_service_account on the dinner object.",
    );
  }
  if (!dinner.square_access_token || !menu.locationId) {
    throw new Error(
      "Pie orders are not configured — set square_location_id on the pie_preorder object and square_access_token on the dinner object.",
    );
  }
  const squareToken = dinner.square_access_token;
  const siteUrl = (objects.SITE_URL || "https://nice-dream.com").replace(/\/+$/, "");
  const fields =
    body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;

  const client = sheetsClient(await accessToken(dinner.google_service_account), objects.pie_preorder.orders_sheet_id);
  await ensureSheet(client, menu);
  const orders = await readOrders(client, menu);

  const lookup = fields ? "" : text(params.get("order"));
  const unsettled = rowsToSync(orders, lookup);
  const [states, placed] = await Promise.all([
    unsettled.length
      ? orderStates(squareToken, menu.locationId, unsettled.map((order) => order.squareOrder))
      : null,
    paidPickupOrders(squareToken, menu.locationId, new Date(Date.now() - LOOKBACK_DAYS * 86_400_000)),
  ]);
  if (states) await applyStates(client, unsettled, states);
  if (placed) {
    const found = planFound(menu, placed, new Set(orders.map((order) => order.squareOrder).filter(Boolean)));
    await appendOrders(client, menu, found.rows).catch((error) => {
      console.error("Could not write Square link orders to the Orders tab:", error);
    });
    await Promise.all(
      found.moves.map((move) =>
        reschedulePickup(squareToken, menu.locationId, move.order, move.fulfillmentUid, move.pickupAt),
      ),
    );
  }

  const taken = piesBySlot(orders);
  const left = (date: string, start: number): number | null =>
    menu.perSlot ? Math.max(0, menu.perSlot - (taken.get(`${date} ${formatHHMM(start)}`) ?? 0)) : null;

  if (!fields) {
    const reply: Reply = {
      ok: true,
      open: isOpen(menu),
      max_per_order: menu.maxPerOrder,
      dates: pickupDates(menu).map((date) => ({
        date,
        label: formatDateLabel(date),
        slots: pickupTimes(menu, date).map((start) => ({
          time: formatHHMM(start),
          label: formatClock(start),
          left: left(date, start),
        })),
      })),
    };
    if (lookup) {
      const order = orders.find((entry) => entry.token === lookup);
      if (order) {
        reply.order = {
          status: order.status,
          name: order.name,
          summary: order.summary,
          pickup:
            order.date && order.start != null
              ? `${formatDateLabel(order.date)} at ${formatClock(order.start)}`
              : "",
          ...(order.status === STATUS.paid || order.status === STATUS.cancelled
            ? {}
            : { checkout_url: order.checkout }),
        };
      } else {
        reply.order_error = `We couldn't find that order. Email us at ${CONTACT_EMAIL} and we'll sort it out.`;
      }
    }
    return reply;
  }

  if (!isOpen(menu)) return refuse(`Pre-orders are closed. Email us at ${CONTACT_EMAIL} if you need a hand.`);

  const selection = parseSelection(fields, menu);
  if ("error" in selection) return refuse(selection.error);

  const date = text(fields.date);
  const start = parseHHMM(text(fields.time));
  if (start == null || !pickupTimes(menu, date).includes(start)) {
    return refuse("Pick one of the pickup times listed.");
  }
  const room = left(date, start);
  if (room != null && pieCount(selection) > room) {
    return refuse(
      room
        ? `That pickup time only has room for ${room} more ${room === 1 ? "pie" : "pies"} — pick another time.`
        : "That pickup time just filled up — pick another time.",
    );
  }

  const name = text(fields.name);
  if (!name) return refuse("Please tell us your name.");
  const email = text(fields.email);
  if (!EMAIL_RE.test(email)) return refuse("That email address doesn't look right.");
  const phone = e164(text(fields.phone));
  if (!phone) return refuse("That phone number doesn't look right.");
  const notes = text(fields.notes);

  const token = randomToken();
  let checkout;
  try {
    checkout = await createCheckout(squareToken, {
      token,
      locationId: menu.locationId,
      lineItems: lineItems(menu, selection),
      pickupAt: localInstant(date, start, TIMEZONE),
      name,
      email,
      phone,
      note: notes,
      redirectUrl: `${siteUrl}${FORM_PATH}?order=${encodeURIComponent(token)}`,
    });
  } catch (error) {
    console.error("Could not start a Square checkout:", error);
    return refuse(`We couldn't start checkout just now — please try again, or email us at ${CONTACT_EMAIL}.`);
  }

  // A row that fails to write is added once the order is paid, by the next
  // request's search of Square.
  await appendOrders(client, menu, [
    {
      date,
      start,
      status: STATUS.awaiting,
      total: "",
      name,
      phone,
      email,
      notes,
      summary: describeSelection(menu, selection),
      selection,
      orderedAt: timestampIn(),
      squareOrder: checkout.orderId,
      checkout: checkout.url,
      token,
    },
  ]).catch((error) => {
    console.error("Could not write a pie order to the Orders tab:", error);
  });

  return { ok: true, checkout_url: checkout.url };
};

export default carrier;
