/**
 * Pie pre-orders — https://<site>/carriers/pies
 *
 *   GET             whether orders are open, and every pickup time with how
 *                   many pies it can still take
 *   GET ?order=     the same, plus that order and whether it has been paid
 *   POST (JSON)     { pies: { <variant id>: quantity }, add_ons, date, time,
 *                     name, email, phone, notes? } — starts a checkout in
 *                     the site's connected payment account, logs it to the
 *                     hidden Checkouts tab, and answers with its URL
 *
 * Every request also asks archival payments whether the checkouts still
 * awaiting payment have been paid, and writes the answer to their rows; a paid
 * one gets a row on the Orders tab.
 *
 * The menu, pickup days and orders spreadsheet live on the pie_preorder
 * object; the Google credentials are the ones the dinner object already holds.
 *
 * Anything the guest can fix comes back as `{ ok: false, error }` with a 200 so
 * the form can show it; only a misconfigured site throws.
 */
import type { Carrier, CarrierJsonValue, CarrierOutOfStockError } from "@archival/carrier";
import { accessToken, sheetsClient } from "./google.ts";
import {
  checkoutItems,
  describeSelection,
  e164,
  formatClock,
  formatDateLabel,
  formatHHMM,
  isOpen,
  parseHHMM,
  parseSelection,
  pickupDates,
  pickupTimes,
  readMenu,
  timestampIn,
} from "./menu.ts";
import { checkoutStates, isDue } from "./payments.ts";
import {
  CHECKOUTS,
  ORDERS,
  STATUS,
  appendOrders,
  applyStates,
  ensureSheet,
  paidOrders,
  readOrders,
  rowsToSync,
} from "./sheet.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTACT_EMAIL = "hello@nice-dream.com";
const FORM_PATH = "/pie-preorder.html";

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";

type Reply = { [key: string]: CarrierJsonValue };

const refuse = (error: string): Reply => ({ ok: false, error });

/** The key in a guest's return link: 144 random bits, URL-safe. */
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
  const dinner = objects.dinner;
  const menu = readMenu(objects.pie_preorder);
  if (!dinner.google_service_account || !objects.pie_preorder.orders_sheet_id) {
    throw new Error(
      "Pie orders are not configured — set orders_sheet_id on the pie_preorder object and google_service_account on the dinner object.",
    );
  }
  const siteUrl = site.url.replace(/\/+$/, "");
  const fields =
    body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;

  const client = sheetsClient(await accessToken(dinner.google_service_account), objects.pie_preorder.orders_sheet_id);
  await ensureSheet(client, menu);
  const [orders, checkouts] = await Promise.all([
    readOrders(client, menu, ORDERS),
    readOrders(client, menu, CHECKOUTS),
  ]);

  const lookup = fields ? "" : text(params.get("order"));
  const unsettled = rowsToSync(checkouts, lookup).filter(
    (checkout) => (lookup !== "" && checkout.token === lookup) || isDue(checkout.checkoutId),
  );
  if (unsettled.length) {
    const states = await checkoutStates(
      site.payments,
      unsettled.map((checkout) => checkout.checkoutId),
    );
    await applyStates(client, unsettled, states);
    const found = paidOrders(unsettled, new Set(orders.map((order) => order.checkoutId).filter(Boolean)));
    await appendOrders(client, menu, ORDERS, found).catch((error) => {
      console.error("Could not write paid pie orders to the Orders tab:", error);
    });
  }

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
        })),
      })),
    };
    if (lookup) {
      const order =
        orders.find((entry) => entry.token === lookup) ?? checkouts.find((entry) => entry.token === lookup);
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
  if (start == null || !pickupDates(menu).includes(date)) {
    return refuse("Pick a pickup day and time.");
  }

  const name = text(fields.name);
  if (!name) return refuse("Please tell us your name.");
  const email = text(fields.email);
  if (!EMAIL_RE.test(email)) return refuse("That email address doesn't look right.");
  const phone = e164(text(fields.phone));
  if (!phone) return refuse("That phone number doesn't look right.");
  const notes = text(fields.notes);

  const token = randomToken();
  const pickup = `${formatDateLabel(date)} at ${formatClock(start)}`;
  let checkout: { id: string; url: string };
  try {
    checkout = await site.payments.checkout.create({
      items: checkoutItems(menu, selection),
      successUrl: `${siteUrl}${FORM_PATH}?order=${encodeURIComponent(token)}`,
      cancelUrl: `${siteUrl}${FORM_PATH}`,
      customerEmail: email,
      metadata: {
        pickup,
        guest: name.slice(0, 255),
        phone,
        ...(notes ? { notes: notes.slice(0, 255) } : {}),
      },
      idempotencyKey: token,
    });
  } catch (error) {
    const short = outOfStock(error);
    if (short.length) {
      const names = menu.pies.filter((pie) => short.includes(pie.id)).map((pie) => pie.name);
      return refuse(
        `${names.length ? names.join(" and ") : "One of those pies"} just sold out — reload the page and pick again.`,
      );
    }
    console.error("Could not start a pie checkout:", error);
    return refuse(`We couldn't start checkout just now — please try again, or email us at ${CONTACT_EMAIL}.`);
  }

  // The Checkouts row is the only record of the pickup time, so a guest whose row can't be written doesn't go on to pay.
  try {
    await appendOrders(client, menu, CHECKOUTS, [
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
        checkoutId: checkout.id,
        checkout: checkout.url,
        token,
      },
    ]);
  } catch (error) {
    console.error("Could not write a pie checkout to the Checkouts tab:", error);
    return refuse(`We couldn't save your order just now — please try again, or email us at ${CONTACT_EMAIL}.`);
  }

  return { ok: true, checkout_url: checkout.url };
};

export default carrier;
