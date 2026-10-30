/**
 * Pie orders found in Square rather than placed through the form — mostly the
 * dashboard checkout link, which can only schedule pickup ASAP. Each one gets a
 * row on the sheet, and a pickup that isn't on a pickup day is moved to the
 * first pickup time.
 */
import {
  type Menu,
  type Selection,
  describeSelection,
  e164,
  localInstant,
  parseHHMM,
  pickupDates,
  pickupTimes,
  pieCount,
  timestampIn,
} from "./menu.ts";
import { type NewOrder, STATUS, dollars } from "./sheet.ts";
import type { PickupOrder } from "./square.ts";

/** How far back Square is searched for pie orders. */
export const LOOKBACK_DAYS = 60;

/** The menu's pies on a Square order, with the add-on counted once per pie that carries it. */
export const selectionOf = (menu: Menu, order: PickupOrder): Selection => {
  const selection: Selection = { pies: new Map(), addOns: 0 };
  for (const item of order.line_items ?? []) {
    const id = item.catalog_object_id ?? "";
    const quantity = Math.round(Number(item.quantity));
    if (!menu.pies.some((pie) => pie.id === id) || !(quantity > 0)) continue;
    selection.pies.set(id, (selection.pies.get(id) ?? 0) + quantity);
    for (const modifier of item.modifiers ?? []) {
      if (menu.addOn && modifier.catalog_object_id === menu.addOn.modifierId) {
        selection.addOns += Math.round(Number(modifier.quantity ?? 1) || 1) * quantity;
      }
    }
  }
  return selection;
};

const pickupOf = (order: PickupOrder) => order.fulfillments?.find((fulfillment) => fulfillment.type === "PICKUP");

/** A scheduled pickup's local date and time, when it falls on one of the menu's pickup days. */
const scheduledPickup = (menu: Menu, order: PickupOrder): { date: string; start: number | null } | null => {
  const details = pickupOf(order)?.pickup_details;
  const at = new Date(details?.pickup_at ?? "");
  if (details?.schedule_type !== "SCHEDULED" || Number.isNaN(at.getTime())) return null;
  const [date, time] = timestampIn(at).split(" ");
  if (!pickupDates(menu).includes(date)) return null;
  const start = parseHHMM(time);
  return { date, start: start != null && pickupTimes(menu, date).includes(start) ? start : null };
};

export type Move = { order: PickupOrder; fulfillmentUid: string; pickupAt: Date };

export type Found = { rows: NewOrder[]; moves: Move[] };

/**
 * Rows for the pie orders the sheet doesn't have yet, and the pickups to move.
 * `known` holds the Square order ids already on the sheet.
 */
export const planFound = (menu: Menu, orders: PickupOrder[], known: Set<string>): Found => {
  const found: Found = { rows: [], moves: [] };
  const first = menu.windows[0];
  if (!first) return found;
  for (const order of orders) {
    const selection = selectionOf(menu, order);
    if (!pieCount(selection)) continue;
    const pickup = pickupOf(order);
    const scheduled = scheduledPickup(menu, order);
    const settled = pickup?.state === "COMPLETED" || pickup?.state === "CANCELED";
    if (!scheduled && pickup?.uid && !settled) {
      found.moves.push({ order, fulfillmentUid: pickup.uid, pickupAt: localInstant(first.date, first.first) });
    }
    if (known.has(order.id)) continue;
    known.add(order.id);
    const recipient = pickup?.pickup_details?.recipient;
    const created = new Date(order.created_at ?? "");
    found.rows.push({
      date: scheduled?.date ?? first.date,
      start: scheduled?.start ?? null,
      status: STATUS.paid,
      total: order.total_money?.amount != null ? dollars(order.total_money.amount) : "",
      name: recipient?.display_name ?? "",
      phone: e164(recipient?.phone_number ?? "") ?? recipient?.phone_number ?? "",
      email: recipient?.email_address ?? "",
      notes: pickup?.pickup_details?.note ?? "",
      summary: describeSelection(menu, selection),
      selection,
      orderedAt: Number.isNaN(created.getTime()) ? "" : timestampIn(created),
      squareOrder: order.id,
      checkout: "",
      token: order.reference_id ?? "",
    });
  }
  return found;
};
