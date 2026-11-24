/**
 * What a Film Studies order can hold, read from the film_studies object, and the
 * pure rules the carrier decides an order with.
 */
import type { CarrierCheckoutItem } from "@archival/carrier";
import type { FilmObject, FilmStudiesObject } from "./archival-objects.d.ts";

export const TIMEZONE = "America/Los_Angeles";

/** A ticket is only sold once it has a name and a price, since the page shows both. */
export type Ticket = { name: string; price: number; variantId: string; available: boolean };

export type Menu = {
  tickets: Ticket[];
  maxPerTicket: number;
  /** Null when a screening takes any number of guests. */
  maxGuests: number | null;
};

/** How many of each ticket, by its position in film_studies.ticket, and the donation in cents. */
export type Selection = { tickets: number[]; donationCents: number };

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";

export const readMenu = (studies: FilmStudiesObject): Menu => ({
  tickets: (studies.ticket ?? []).map((ticket) => {
    const name = text(ticket.name);
    const price = ticket.price != null && Number.isFinite(ticket.price) && ticket.price > 0 ? ticket.price : 0;
    return { name, price, variantId: text(ticket.variant_id), available: name !== "" && price > 0 };
  }),
  maxPerTicket:
    studies.max_per_ticket != null && studies.max_per_ticket >= 1 ? Math.floor(studies.max_per_ticket) : 10,
  maxGuests: studies.max_guests != null && studies.max_guests >= 1 ? Math.floor(studies.max_guests) : null,
});

/** `"film/footprints"` or `"footprints"` → that film. */
export const findFilm = (films: FilmObject[], slug: string): FilmObject | null => {
  const name = slug.trim().replace(/^\/?film\//, "");
  if (!name || name.includes("/")) return null;
  return films.find((film) => film.path === `film/${name}`) ?? null;
};

/** The film that screens latest, which /film-studies shows. */
export const latestFilm = (films: FilmObject[]): FilmObject | null =>
  films.reduce<FilmObject | null>((latest, film) => {
    const at = localStamp(film.starts);
    if (!at) return latest;
    return !latest || at > (localStamp(latest.starts) ?? "") ? film : latest;
  }, null);

/** A `date` field, however archival wrote it, as `"YYYY-MM-DD HH:MM"` restaurant time. */
export const localStamp = (value: string | null | undefined): string | null => {
  const match = (value ?? "").match(/(\d{4}-\d{2}-\d{2})(?:[T\s]+(\d{1,2}):(\d{2}))?/);
  if (!match) return null;
  return `${match[1]} ${(match[2] ?? "00").padStart(2, "0")}:${match[3] ?? "00"}`;
};

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
  const wall = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
  return Math.round((wall - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
};

/** `"2026-12-01 18:00"` restaurant time → that instant. */
export const localInstant = (stamp: string, timezone: string = TIMEZONE): Date => {
  const [date, time] = stamp.split(" ");
  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);
  const wall = Date.UTC(year, month - 1, day, hours, minutes);
  const guess = wall - offsetMinutes(timezone, new Date(wall)) * 60_000;
  return new Date(wall - offsetMinutes(timezone, new Date(guess)) * 60_000);
};

/** Whether online tickets are still sold for a film: until it starts. */
export const isOnSale = (film: FilmObject, now: Date = new Date()): boolean => {
  const stamp = localStamp(film.starts);
  return stamp != null && now < localInstant(stamp);
};

/** `"$12.50"` or `12.5` → 1250; anything that isn't a sensible amount → null. */
export const parseDollars = (value: unknown): number | null => {
  const raw = text(value).replace(/[$,\s]/g, "");
  if (!raw) return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  return Math.round(Number(raw) * 100);
};

export const parseSelection = (fields: Record<string, unknown>, menu: Menu): Selection | { error: string } => {
  const counts = fields.tickets && typeof fields.tickets === "object" ? (fields.tickets as Record<string, unknown>) : {};
  const tickets = menu.tickets.map(() => 0);
  for (const [key, value] of Object.entries(counts)) {
    const index = Number(key);
    const count = Number(value);
    if (!Number.isInteger(count) || count < 0 || count > menu.maxPerTicket) {
      return { error: `Up to ${menu.maxPerTicket} of each ticket per order.` };
    }
    if (!count) continue;
    if (!Number.isInteger(index) || !menu.tickets[index]?.available) {
      return { error: "That ticket isn't on offer any more — refresh the page and try again." };
    }
    tickets[index] = count;
  }
  const donationCents = parseDollars(fields.donation);
  if (donationCents == null) return { error: "Enter the tip in dollars, like 20." };
  if (donationCents > 0 && donationCents < 100) return { error: "Tips start at $1." };
  if (!tickets.some((count) => count > 0) && !donationCents) {
    return { error: "Pick a ticket or add a tip." };
  }
  return { tickets, donationCents };
};

export const ticketCount = (selection: Selection): number => selection.tickets.reduce((sum, count) => sum + count, 0);

/** How long a checkout that hasn't been paid yet keeps its spots. */
export const HOLD_MINUTES = 20;

export type HeldCheckout = { status: string; guests: number; createdAt: number };

/** Guests with a spot: paid checkouts, and checkouts started within HOLD_MINUTES. */
export const guestsHeld = (checkouts: HeldCheckout[], now: number = Date.now()): number =>
  checkouts.reduce((sum, checkout) => {
    const age = now - checkout.createdAt;
    const holding = checkout.status === "open" && age >= 0 && age < HOLD_MINUTES * 60_000;
    return checkout.status === "paid" || holding ? sum + checkout.guests : sum;
  }, 0);

export const spotsLeft = (menu: Menu, taken: number): number | null =>
  menu.maxGuests == null ? null : Math.max(0, menu.maxGuests - taken);

export const spotsRefusal = (left: number): string =>
  left === 0
    ? "We're sold out for this screening! You can still add a tip."
    : `Only ${left} ticket${left === 1 ? "" : "s"} left.`;

const cents = (dollars: number): number => Math.round(dollars * 100);

export const DONATION_NAME = "Tip Your Professor";

/** How long a checkout line's note can be. */
const NOTE_LENGTH = 500;

/**
 * The checkout's lines: variants where set, lines at the page's price
 * otherwise, and the donation. `note` rides on the first line, where the
 * provider shows it on the order.
 */
export const checkoutItems = (menu: Menu, selection: Selection, note = ""): CarrierCheckoutItem[] => {
  const items: CarrierCheckoutItem[] = [];
  menu.tickets.forEach((ticket, index) => {
    const quantity = selection.tickets[index] ?? 0;
    if (!quantity || !ticket.available) return;
    items.push(
      ticket.variantId
        ? { variant: ticket.variantId, quantity }
        : { name: ticket.name, amount: cents(ticket.price), quantity },
    );
  });
  if (selection.donationCents) items.push({ name: DONATION_NAME, amount: selection.donationCents, quantity: 1 });
  if (note && items.length) items[0] = { ...items[0], note: note.slice(0, NOTE_LENGTH) };
  return items;
};

export const money = (amountCents: number): string =>
  amountCents % 100 ? `$${(amountCents / 100).toFixed(2)}` : `$${amountCents / 100}`;

/** e.g. "2 Admissions, a $20 tip". */
export const describeSelection = (menu: Menu, selection: Selection): string => {
  const parts = menu.tickets.flatMap((ticket, index) => {
    const quantity = selection.tickets[index] ?? 0;
    if (!quantity) return [];
    return [`${quantity} ${ticket.name}${quantity === 1 ? "" : "s"}`];
  });
  if (selection.donationCents) parts.push(`a ${money(selection.donationCents)} tip`);
  return parts.join(", ");
};

export const e164 = (value: string): string | null => {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
};
