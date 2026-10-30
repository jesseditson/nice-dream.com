/**
 * What can be ordered and when it can be picked up, read from the pie_preorder
 * object, and the pure rules the carrier decides an order with.
 */
import type { PiePreorderObject } from "./archival-objects.d.ts";

export const TIMEZONE = "America/Los_Angeles";

/** A pie, keyed by the Square catalog item variation it sells as. */
export type Pie = { id: string; name: string; price: number };

export type AddOn = { name: string; price: number; modifierId: string };

export type PickupWindow = { date: string; first: number; last: number };

export type Menu = {
  pies: Pie[];
  addOn: AddOn | null;
  windows: PickupWindow[];
  slotMinutes: number;
  maxPerOrder: number;
  /** When orders stop being taken; null takes them indefinitely. */
  closesAt: Date | null;
  locationId: string;
};

/** How many of each pie, by variation id, and how many of them carry the add-on. */
export type Selection = { pies: Map<string, number>; addOns: number };

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const isIsoDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);

export const parseHHMM = (value: string): number | null => {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})(?:\s*([ap])\.?m?\.?)?$/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === "p" && hours < 12) hours += 12;
  if (meridiem === "a" && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
};

export const formatHHMM = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** `750` → `"12:30 PM"`. */
export const formatClock = (minutes: number): string => {
  const hours24 = Math.floor(minutes / 60);
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${hours12}:${String(minutes % 60).padStart(2, "0")} ${hours24 < 12 ? "AM" : "PM"}`;
};

const ordinal = (day: number): string => {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  switch (day % 10) {
    case 1: return `${day}st`;
    case 2: return `${day}nd`;
    case 3: return `${day}rd`;
    default: return `${day}th`;
  }
};

/** `"2026-11-25"` → `"Wednesday, November 25th"`. */
export const formatDateLabel = (date: string): string => {
  const [year, month, day] = date.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${WEEKDAYS[weekday]}, ${MONTHS[month - 1]} ${ordinal(day)}`;
};

/** Minutes `timezone` is ahead of UTC at `at`. */
const offsetMinutes = (timezone: string, at: Date): number => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
  const local = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
  return (local - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000;
};

/** The instant a local date and time happen in `timezone`. */
export const localInstant = (date: string, minutes: number, timezone: string = TIMEZONE): Date => {
  const [year, month, day] = date.split("-").map(Number);
  const wall = Date.UTC(year, month - 1, day, 0, minutes);
  const guess = wall - offsetMinutes(timezone, new Date(wall)) * 60_000;
  return new Date(wall - offsetMinutes(timezone, new Date(guess)) * 60_000);
};

/** `"2026-11-21 23:59"` → that instant in the restaurant's timezone. */
export const parseLocalTimestamp = (value: string, timezone: string = TIMEZONE): Date | null => {
  const [date, time] = value.trim().split(/[\sT]+/);
  const minutes = parseHHMM(time ?? "");
  if (!date || !isIsoDate(date) || minutes == null) return null;
  return localInstant(date, minutes, timezone);
};

/** A local timestamp for the sheet, e.g. `"2026-11-02 14:05"`. */
export const timestampIn = (at: Date = new Date(), timezone: string = TIMEZONE): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(at);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
};

const whole = (value: number | null | undefined, fallback: number): number =>
  value != null && Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;

export const readMenu = (pies: PiePreorderObject): Menu => {
  const windows: PickupWindow[] = [];
  for (const window of pies.pickup_windows ?? []) {
    const date = (window.date ?? "").trim();
    const first = parseHHMM(window.first ?? "");
    const last = parseHHMM(window.last ?? "");
    if (!isIsoDate(date) || first == null || last == null || last < first) continue;
    windows.push({ date, first, last });
  }
  windows.sort((a, b) => a.date.localeCompare(b.date) || a.first - b.first);
  const addOnName = (pies.add_on_name ?? "").trim();
  const modifierId = (pies.add_on_modifier_id ?? "").trim();
  return {
    pies: (pies.pies ?? []).flatMap((pie) => {
      const id = (pie.square_variation_id ?? "").trim();
      const name = (pie.name ?? "").trim();
      return id && name ? [{ id, name, price: pie.price ?? 0 }] : [];
    }),
    addOn: addOnName && modifierId ? { name: addOnName, price: pies.add_on_price ?? 0, modifierId } : null,
    windows,
    slotMinutes: Math.max(5, whole(pies.slot_minutes, 30)),
    maxPerOrder: Math.max(1, whole(pies.max_per_order, 6)),
    closesAt: parseLocalTimestamp(pies.orders_close ?? ""),
    locationId: (pies.square_location_id ?? "").trim(),
  };
};

export const isOpen = (menu: Menu, now: Date = new Date()): boolean =>
  menu.closesAt == null || now.getTime() <= menu.closesAt.getTime();

/** Every pickup time on `date`, as minutes past midnight. */
export const pickupTimes = (menu: Menu, date: string): number[] => {
  const times: number[] = [];
  for (const window of menu.windows.filter((entry) => entry.date === date)) {
    for (let time = window.first; time <= window.last; time += menu.slotMinutes) {
      if (!times.includes(time)) times.push(time);
    }
  }
  return times.sort((a, b) => a - b);
};

export const pickupDates = (menu: Menu): string[] => [...new Set(menu.windows.map((window) => window.date))];

export const pieCount = (selection: Selection): number =>
  [...selection.pies.values()].reduce((sum, count) => sum + count, 0);

/**
 * The order's Square line items. The add-on is a modifier, which Square
 * charges once per unit of its line, so a pie split between some with the
 * add-on and some without becomes two lines.
 */
export const lineItems = (menu: Menu, selection: Selection) => {
  let addOns = menu.addOn ? selection.addOns : 0;
  const items: {
    catalog_object_id: string;
    quantity: string;
    modifiers?: { catalog_object_id: string }[];
  }[] = [];
  for (const pie of menu.pies) {
    const quantity = selection.pies.get(pie.id) ?? 0;
    if (!quantity) continue;
    const withAddOn = Math.min(quantity, addOns);
    addOns -= withAddOn;
    if (withAddOn && menu.addOn) {
      items.push({
        catalog_object_id: pie.id,
        quantity: String(withAddOn),
        modifiers: [{ catalog_object_id: menu.addOn.modifierId }],
      });
    }
    if (quantity > withAddOn) items.push({ catalog_object_id: pie.id, quantity: String(quantity - withAddOn) });
  }
  return items;
};

/** `"2 × Passionfruit Meringue, 1 × Fig Leaf Apple Crumble + 1 × Pint of Vanilla Bean"`. */
export const describeSelection = (menu: Menu, selection: Selection): string => {
  const pies = menu.pies
    .filter((pie) => (selection.pies.get(pie.id) ?? 0) > 0)
    .map((pie) => `${selection.pies.get(pie.id)} × ${pie.name}`)
    .join(", ");
  return menu.addOn && selection.addOns > 0 ? `${pies} + ${selection.addOns} × ${menu.addOn.name}` : pies;
};

/** The pre-tax price the page shows; Square charges its own catalog prices. */
export const subtotal = (menu: Menu, selection: Selection): number =>
  menu.pies.reduce((sum, pie) => sum + pie.price * (selection.pies.get(pie.id) ?? 0), 0) +
  (menu.addOn ? menu.addOn.price * selection.addOns : 0);

type Refusal = { error: string };

const count = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(typeof value === "string" ? value.trim() : NaN);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : NaN;
};

/** `{ pies: { <variation id>: quantity }, add_ons }` from the form. */
export const parseSelection = (fields: Record<string, unknown>, menu: Menu): Selection | Refusal => {
  const requested =
    fields.pies && typeof fields.pies === "object" && !Array.isArray(fields.pies)
      ? (fields.pies as Record<string, unknown>)
      : {};
  const pies = new Map<string, number>();
  for (const [id, value] of Object.entries(requested)) {
    const quantity = count(value);
    if (Number.isNaN(quantity)) return { error: "Pick how many of each pie you'd like." };
    if (!quantity) continue;
    if (!menu.pies.some((pie) => pie.id === id)) {
      return { error: "One of those pies isn't on the menu anymore — reload the page and try again." };
    }
    pies.set(id, quantity);
  }
  const selection: Selection = { pies, addOns: menu.addOn ? count(fields.add_ons ?? 0) : 0 };
  const total = pieCount(selection);
  if (!total) return { error: "Pick at least one pie." };
  if (total > menu.maxPerOrder) {
    return { error: `We can take up to ${menu.maxPerOrder} pies per order — email us for more.` };
  }
  if (Number.isNaN(selection.addOns) || selection.addOns > total) {
    return { error: `You can add up to one ${menu.addOn?.name ?? "add-on"} per pie.` };
  }
  return selection;
};

/** A US number as Square wants it, `+1XXXXXXXXXX`; null when it isn't one. */
export const e164 = (value: string): string | null => {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
};
