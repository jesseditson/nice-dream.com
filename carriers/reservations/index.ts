/**
 * Reservations carrier — https://<site>/carriers/reservations
 *
 *   GET            every seating we offer in the booking window, and which
 *                  party sizes each one can still take
 *   GET ?token=    the same, plus the booking the token belongs to, with its
 *                  own tables counted as free so the form can offer them back
 *   POST (JSON)    { party_size, date, time, name, contact_method, email?,
 *                    phone?, notes?, newsletter?, area? } — takes a booking,
 *                    in the dining room unless `area` is "bar", emails a
 *                    summary to each of `dinner.reservation_emails` (or, if
 *                    the Tracker can't be written, an alert to add it by hand)
 *                    and a confirmation to the guest with their edit link
 *   POST (JSON)    { token, ...the fields above } — changes that booking on
 *                    its Tracker row, noting what changed to the right of it
 *   POST (JSON)    { token, cancel: true } — cancels it: Status becomes
 *                    cancelled and the row is struck through
 *   POST (JSON)    { walk_in, key, check? } — sent by the Square order webhook
 *                    when a ticket opens; holds the table the ticket is named for
 *
 * Every request also brings the Tracker in line with the checks open in Square:
 * a walk-in gets a row, and the row is marked `left` when its check closes.
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
  type Area,
  type Booking,
  type Rules,
  availabilityOn,
  formatClock,
  formatDateLabel,
  formatHHMM,
  holdFor,
  isIsoDate,
  nowMinutesIn,
  occupiedAt,
  parseHHMM,
  readRules,
  seatParty,
  serviceDates,
  slotsOn,
  timestampIn,
  todayIn,
  turningAt,
  walkInAt,
} from "./room";
import {
  CONTACT_EMAIL,
  type Notice,
  alertUnsaved,
  cancelledEmail,
  changedEmail,
  emailGuest,
  emailStaff,
  guestBookedEmail,
  guestCancelledEmail,
  guestChangedEmail,
  notifyStaff,
} from "./notify";
import {
  type Changes,
  type NewBooking,
  type TrackerRow,
  appendBooking,
  cancelBooking,
  findBooking,
  readBookings,
  syncWalkIns,
  updateBooking,
  walkInRow,
} from "./sheet";
import { ensureSheet } from "./setup";
import { openTickets } from "./square";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const FORM_PATH = "/reservations.html";

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

/** The key in a guest's edit link: 144 random bits, URL-safe. */
const randomToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const areaOf = (tables: string[]): Area =>
  tables.length && tables.every((table) => table.startsWith("B")) ? "bar" : "dining";

const SMS = "Text (SMS)";
const EMAIL = "Email";

const sameList = (a: string[], b: string[]): boolean => a.join(",") === b.join(",");

/** The fields a guest fills in, checked the same way whether they're booking or changing a booking. */
type Request = {
  area: Area;
  party: number;
  date: string;
  start: number;
  name: string;
  sms: boolean;
  contact: string;
  notes: string;
  newsletter: boolean;
};

type Refusal = { error: string };

const parseRequest = (
  fields: Record<string, unknown>,
  rules: Rules,
  dates: string[],
  earliest: (date: string) => number,
): Request | Refusal => {
  const area: Area = text(fields.area).toLowerCase() === "bar" ? "bar" : "dining";
  const party = integer(fields.party_size);
  const date = text(fields.date);
  const start = parseHHMM(text(fields.time));
  const name = text(fields.name);
  const method = text(fields.contact_method).toLowerCase();
  const sms = method === "sms" || method.startsWith("text");
  const contact = sms ? text(fields.phone) : text(fields.email);
  const notes = text(fields.notes);

  if (!name) return { error: "Please tell us whose name the table is under." };
  if (!contact) {
    return {
      error: sms ? "Please leave a mobile number so we can reach you." : "Please leave an email so we can reach you.",
    };
  }
  if (!sms && !EMAIL_RE.test(contact)) return { error: "That email address doesn't look right." };
  if (sms && contact.replace(/\D/g, "").length < 7) return { error: "That phone number doesn't look right." };
  if (!Number.isFinite(party) || party < 1) return { error: "How many are coming?" };
  if (area === "bar" && !rules.barSeats) return { error: "We aren't taking reservations at the bar." };
  if (area === "bar" && party > rules.barSeats) {
    return { error: `The bar seats parties of up to ${rules.barSeats} — choose the dining room for a larger group.` };
  }
  if (party > rules.maxParty) {
    return { error: `We can seat parties of up to ${rules.maxParty} online — email us for anything larger.` };
  }
  if (!isIsoDate(date) || !dates.includes(date)) return { error: "Please pick one of the dates offered." };
  if (start == null || !slotsOn(date, rules).includes(start)) {
    return { error: "Please pick one of the seating times offered." };
  }
  if (start <= earliest(date)) return { error: "That seating has already passed — pick a later one." };
  return { area, party, date, start, name, sms, contact, notes, newsletter: truthy(fields.newsletter) };
};

/** What the form shows after a booking, a change or a cancellation. */
const bookingReply = (booking: Booking & { name: string }, area: Area, largeParty: boolean): Reply => ({
  ok: true,
  date: booking.date,
  date_label: formatDateLabel(booking.date),
  time: formatHHMM(booking.start),
  time_label: formatClock(booking.start),
  party_size: booking.party,
  name: booking.name,
  area,
  tables: booking.tables,
  large_party: largeParty,
});

/** `old → new`, for the note on the Tracker row and the email to staff. */
const describeChanges = (before: TrackerRow, after: Request, tables: string[]): string[] => {
  const changes: string[] = [];
  if (after.date !== before.date) changes.push(`date ${formatDateLabel(before.date)} → ${formatDateLabel(after.date)}`);
  if (after.start !== before.start) changes.push(`time ${formatClock(before.start)} → ${formatClock(after.start)}`);
  if (after.party !== before.party) changes.push(`party ${before.party} → ${after.party}`);
  if (after.area !== areaOf(before.tables)) changes.push(`area ${areaOf(before.tables)} → ${after.area}`);
  if (!sameList(tables, before.tables)) changes.push(`tables ${before.tables.join(", ")} → ${tables.join(", ")}`);
  if (after.name !== before.name) changes.push(`name ${before.name} → ${after.name}`);
  const method = after.sms ? SMS : EMAIL;
  if (method !== before.method || after.contact !== before.contact) {
    changes.push(`contact ${before.method} ${before.contact} → ${method} ${after.contact}`);
  }
  if (after.notes !== before.notes) changes.push(`notes "${before.notes}" → "${after.notes}"`);
  if (after.newsletter !== before.newsletter) {
    changes.push(`newsletter ${before.newsletter ? "yes" : "no"} → ${after.newsletter ? "yes" : "no"}`);
  }
  return changes;
};

const carrier: Carrier = async (params, body, objects) => {
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
  const fields =
    body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const siteUrl = (objects.SITE_URL || "https://nice-dream.com").replace(/\/+$/, "");
  const manageUrl = (token: string): string => `${siteUrl}${FORM_PATH}?token=${encodeURIComponent(token)}`;
  const staff = dinner.reservation_emails.map((recipient) => recipient.email ?? "");

  let walkIn: Booking | null = null;
  if (fields && "walk_in" in fields) {
    if (!dinner.walk_in_key || text(fields.key) !== dinner.walk_in_key) {
      return refuse("Walk-ins need the walk-in key.");
    }
    walkIn = walkInAt(text(fields.walk_in), today, now, rules);
    if (!walkIn) return reply({ ok: true, held: false });
    if (text(fields.check)) walkIn.check = text(fields.check);
  }

  const checks =
    dinner.square_access_token && dinner.square_location_id
      ? openTickets(dinner.square_access_token, dinner.square_location_id, rules.timezone)
      : null;
  const client = sheetsClient(
    await accessToken(dinner.google_service_account),
    dinner.reservations_sheet_id,
  );
  await ensureSheet(client, rules);
  const bookings = await syncWalkIns(client, await readBookings(client, rules, today), await checks, rules);

  /** Everything held except `own`, so its own tables count as free while it's being changed. */
  const without = (own: TrackerRow): Booking[] =>
    bookings.filter((booking) => (booking as { row?: number }).row !== own.row);
  const passed = (own: TrackerRow): boolean => own.date < today || (own.date === today && own.start <= earliest(own.date));
  const noticeFor = (own: TrackerRow, token: string): Notice => ({
    ...own,
    area: areaOf(own.tables),
    largeParty: areaOf(own.tables) === "dining" && own.party >= rules.largePartyMin,
    sheetId: dinner.reservations_sheet_id ?? "",
    siteUrl,
    manageUrl: manageUrl(token),
  });
  const replyToFor = (notice: Notice): string | undefined => (notice.method === EMAIL ? notice.contact : undefined);

  // ---- POST: hold a walk-in's table -----------------------------------------
  if (walkIn) {
    const [table] = walkIn.tables;
    const hold = holdFor(walkIn.party, rules);
    // A table already held for these hours is the booked party sitting down.
    const booked = occupiedAt(bookings, walkIn.date, walkIn.start, hold, rules).has(table);
    if (!booked) await appendBooking(client, walkInRow(walkIn), rules);
    return reply({ ok: true, held: !booked, table });
  }

  // ---- POST with a token: change or cancel a booking -------------------------
  if (fields && text(fields.token)) {
    const token = text(fields.token);
    const own = await findBooking(client, token);
    if (!own) return refuse(`We couldn't find that reservation. Email us at ${CONTACT_EMAIL} and we'll sort it out.`);
    if (own.status !== "booked") {
      return refuse("That reservation was already cancelled. You're welcome to book a new one.");
    }
    if (passed(own)) return refuse(`That seating has already passed, so it can't be changed online. Email us at ${CONTACT_EMAIL}.`);
    const before = noticeFor(own, token);

    if (truthy(fields.cancel)) {
      await cancelBooking(client, own.row, `cancelled ${timestampIn(rules.timezone)}`);
      await emailStaff(objects.EMAIL, staff, cancelledEmail(objects.emails, before), replyToFor(before));
      await emailGuest(objects.EMAIL, before, guestCancelledEmail(objects.emails, before, `${siteUrl}${FORM_PATH}`));
      return reply({ ...bookingReply(own, before.area, false), cancelled: true });
    }

    const request = parseRequest(fields, rules, dates, earliest);
    if ("error" in request) return refuse(request.error);

    const others = without(own);
    const reseat =
      request.date !== own.date ||
      request.start !== own.start ||
      request.party !== own.party ||
      request.area !== before.area;
    let tables = own.tables;
    if (reseat) {
      const hold = holdFor(request.party, rules);
      const seated = seatParty(
        request.area,
        request.party,
        occupiedAt(others, request.date, request.start, hold, rules),
        rules,
        turningAt(others, request.date, request.start, hold, rules),
      );
      if (!seated) return refuse("Sorry — that time just filled up. Your original reservation still stands.");
      tables = seated;
    }

    const changes = describeChanges(own, request, tables);
    const largeParty = request.area === "dining" && request.party >= rules.largePartyMin;
    const updated: Booking & { name: string } = { date: request.date, start: request.start, party: request.party, tables, name: request.name };
    if (!changes.length) {
      return reply({ ...bookingReply(updated, request.area, largeParty), changed: false, manage_url: manageUrl(token) });
    }

    const cells: Changes = {
      date: request.date,
      start: request.start,
      party: request.party,
      tables,
      name: request.name,
      method: request.sms ? SMS : EMAIL,
      contact: request.contact,
      notes: request.notes,
      newsletter: request.newsletter,
    };
    await updateBooking(client, own.row, cells, `edited ${timestampIn(rules.timezone)} - ${changes.join(", ")}`);

    const after: Notice = { ...before, ...cells, largeParty, area: request.area };
    await emailStaff(objects.EMAIL, staff, changedEmail(objects.emails, after, changes.join(", ")), replyToFor(after));
    await emailGuest(objects.EMAIL, after, guestChangedEmail(objects.emails, after));
    return reply({ ...bookingReply(updated, request.area, largeParty), changed: true, manage_url: manageUrl(token) });
  }

  // ---- POST: take a booking -------------------------------------------------
  if (body) {
    if (!fields) return refuse("Send the booking as a JSON object or a form post.");
    const request = parseRequest(fields, rules, dates, earliest);
    if ("error" in request) return refuse(request.error);
    const { area, party, date, start, name, sms, contact, notes, newsletter } = request;

    // Availability is decided here, from a fresh read, so a form left open can't
    // take a table that filled up in the meantime.
    const hold = holdFor(party, rules);
    const tables = seatParty(
      area,
      party,
      occupiedAt(bookings, date, start, hold, rules),
      rules,
      turningAt(bookings, date, start, hold, rules),
    );
    if (!tables) return refuse("Sorry — that time just filled up. Pick another and we'll hold it for you.");

    const token = randomToken();
    const booking: NewBooking = {
      date,
      start,
      tables,
      party,
      name,
      method: sms ? SMS : EMAIL,
      contact,
      notes,
      newsletter,
      token,
    };
    const largeParty = area === "dining" && party >= rules.largePartyMin;
    const notice: Notice = {
      ...booking,
      area,
      largeParty,
      sheetId: dinner.reservations_sheet_id,
      siteUrl,
      manageUrl: manageUrl(token),
    };
    const replyTo = sms ? undefined : contact;
    try {
      await appendBooking(client, booking, rules);
    } catch (error) {
      await alertUnsaved(objects.emails, objects.EMAIL, staff, notice, error, replyTo);
      throw error;
    }
    await notifyStaff(objects.emails, objects.EMAIL, staff, notice, replyTo);
    await emailGuest(objects.EMAIL, notice, guestBookedEmail(objects.emails, notice));

    return reply({ ...bookingReply(booking, area, largeParty), manage_url: manageUrl(token) });
  }

  // ---- GET: what's still open ----------------------------------------------
  const token = text(params.get("token"));
  const own = token ? await findBooking(client, token) : null;
  const editable = own != null && own.status === "booked" && !passed(own);
  const held = own && editable ? without(own) : bookings;

  const existing: Reply = own
    ? {
        booking: {
          ...bookingReply(own, areaOf(own.tables), false),
          contact_method: own.method === SMS ? "sms" : "email",
          contact: own.contact,
          notes: own.notes,
          newsletter: own.newsletter,
          status: own.status,
          editable,
          ...(editable ? {} : { reason: own.status !== "booked" ? "cancelled" : "passed" }),
        },
      }
    : token
      ? { booking_error: "We couldn't find that reservation — it may have been removed. You can book a new one below." }
      : {};

  return reply({
    ok: true,
    timezone: rules.timezone,
    today,
    max_party: rules.maxParty,
    large_party_min: rules.largePartyMin,
    bar_seats: rules.barSeats,
    hold_minutes: rules.holdMinutes,
    ...existing,
    dates: dates.map((date) => ({
      date,
      label: formatDateLabel(date),
      slots: availabilityOn(date, held, rules, earliest(date)).map((slot) => ({
        time: formatHHMM(slot.time),
        label: formatClock(slot.time),
        dining: slot.dining,
        bar: slot.bar,
      })),
    })),
  });
};

export default carrier;
