/**
 * Reservations carrier — https://<site>/carriers/reservations
 *
 *   GET            every seating we offer in the booking window, and which
 *                  party sizes each one can still take
 *   POST (JSON)    { party_size, date, time, name, contact_method, email?,
 *                    phone?, notes?, newsletter? } — takes a booking
 *
 * The rules (nights, seating times, table counts) and the Google credentials
 * all live on the dinner object, so the room is edited as content.
 *
 * Anything the guest can fix comes back as `{ ok: false, error }` with a 200 so
 * the form can show it; only a misconfigured site throws.
 */
import type { Carrier, CarrierJsonValue } from "@archival/carrier";
import { accessToken, sheetsClient } from "./google";
import {
  assignTables,
  availabilityOn,
  formatClock,
  formatDateLabel,
  formatHHMM,
  isIsoDate,
  nowMinutesIn,
  occupiedAt,
  parseHHMM,
  readRules,
  seatingFor,
  serviceDates,
  slotsOn,
  todayIn,
} from "./room";
import { appendBooking, readBookings } from "./sheet";
import { ensureSheet } from "./setup";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";

const integer = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(text(value));
  return Number.isFinite(parsed) ? Math.round(parsed) : NaN;
};

const truthy = (value: unknown): boolean =>
  value === true || ["yes", "true", "on", "1"].includes(text(value).toLowerCase());

type Reply = { [key: string]: CarrierJsonValue };

const reply = (value: Reply): Reply => value;
const refuse = (error: string): Reply => ({ ok: false, error });

const carrier: Carrier = async (_params, body, objects) => {
  const dinner = objects.dinner;
  if (!dinner.google_service_account || !dinner.reservations_sheet_id) {
    throw new Error(
      "Reservations are not configured — set google_service_account and reservations_sheet_id on the dinner object.",
    );
  }

  const rules = readRules(dinner);
  const today = todayIn(rules.timezone);
  const now = nowMinutesIn(rules.timezone);
  const dates = serviceDates(today, rules);
  const earliest = (date: string): number => (date === today ? now : -1);

  const client = sheetsClient(
    await accessToken(dinner.google_service_account),
    dinner.reservations_sheet_id,
  );
  await ensureSheet(client, rules);
  const bookings = await readBookings(client, rules, today);

  // ---- POST: take a booking -------------------------------------------------
  if (body) {
    if (typeof body !== "object" || Array.isArray(body)) {
      return refuse("Send the booking as a JSON object or a form post.");
    }
    const fields = body as Record<string, unknown>;
    const party = integer(fields.party_size);
    const date = text(fields.date);
    const start = parseHHMM(text(fields.time));
    const name = text(fields.name);
    const method = text(fields.contact_method).toLowerCase();
    const sms = method === "sms" || method.startsWith("text");
    const contact = sms ? text(fields.phone) : text(fields.email);
    const notes = text(fields.notes);

    if (!name) return refuse("Please tell us whose name the table is under.");
    if (!contact) {
      return refuse(
        sms ? "Please leave a mobile number so we can reach you." : "Please leave an email so we can reach you.",
      );
    }
    if (!sms && !EMAIL_RE.test(contact)) return refuse("That email address doesn't look right.");
    if (sms && contact.replace(/\D/g, "").length < 7) return refuse("That phone number doesn't look right.");
    if (!Number.isFinite(party) || party < 1) return refuse("How many are coming?");
    if (party > rules.maxParty) {
      return refuse(`We can seat parties of up to ${rules.maxParty} online — email us for anything larger.`);
    }
    if (!isIsoDate(date) || !dates.includes(date)) return refuse("Please pick one of the dates offered.");
    if (start == null || !slotsOn(date, rules).includes(start)) {
      return refuse("Please pick one of the seating times offered.");
    }
    if (start <= earliest(date)) return refuse("That seating has already passed — pick a later one.");

    // Availability is decided here, from a fresh read, so a form left open can't
    // take a table that filled up in the meantime.
    const tables = assignTables(seatingFor(party), occupiedAt(bookings, date, start, rules), rules);
    if (!tables) return refuse("Sorry — that time just filled up. Pick another and we'll hold it for you.");

    await appendBooking(
      client,
      {
        date,
        start,
        tables,
        party,
        name,
        method: sms ? "Text (SMS)" : "Email",
        contact,
        notes,
        newsletter: truthy(fields.newsletter),
      },
      rules,
    );

    return reply({
      ok: true,
      date,
      date_label: formatDateLabel(date),
      time: formatHHMM(start),
      time_label: formatClock(start),
      party_size: party,
      name,
      tables,
      large_party: party >= rules.largePartyMin,
    });
  }

  // ---- GET: what's still open ----------------------------------------------
  return reply({
    ok: true,
    timezone: rules.timezone,
    today,
    max_party: rules.maxParty,
    large_party_min: rules.largePartyMin,
    hold_minutes: rules.holdMinutes,
    dates: dates.map((date) => ({
      date,
      label: formatDateLabel(date),
      slots: availabilityOn(date, bookings, rules, earliest(date)).map((slot) => ({
        time: formatHHMM(slot.time),
        label: formatClock(slot.time),
        two: slot.two,
        four: slot.four,
        communal: slot.communal,
      })),
    })),
  });
};

export default carrier;
