/**
 * The emails a booking sends: a summary to staff — each address in
 * `dinner.reservation_emails` — whenever a booking is taken, changed or
 * cancelled, a louder one when a booking couldn't be written to the Tracker,
 * and a confirmation to the guest with the link that lets them change or
 * cancel it.
 */
import type { CarrierEmail } from "@archival/carrier";
import { type Area, formatClock, formatDateLabel } from "./room.ts";
import type { NewBooking } from "./sheet.ts";

export const NOTIFY_FROM = "reservation@nice-dream.com";
export const CONTACT_EMAIL = "hello@nice-dream.com";

const MAX_RECIPIENTS = 10;

export type Notice = NewBooking & {
  area: Area;
  largeParty: boolean;
  sheetId: string;
  /** Where the guest can change or cancel the booking; absent when it isn't on the sheet. */
  manageUrl?: string;
};

export type Message = { subject: string; text: string };

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

const when = (booking: Notice): string => `${formatDateLabel(booking.date)} at ${formatClock(booking.start)}`;

const seating = (booking: Notice): string => {
  const plural = booking.tables.length > 1;
  return booking.area === "bar"
    ? `Bar, ${plural ? "seats" : "seat"} ${booking.tables.join(", ")}`
    : `Dining room, ${plural ? "tables" : "table"} ${booking.tables.join(", ")}`;
};

/** The booking as staff see it, under a lead line. */
const staffEmail = (subject: string, lead: string, booking: Notice): Message => {
  const lines = [
    lead,
    "",
    `When: ${when(booking)}`,
    `Party: ${booking.party}`,
    `Seating: ${seating(booking)}`,
    `${booking.method}: ${booking.contact}`,
  ];
  if (booking.notes) lines.push(`Notes: ${booking.notes}`);
  if (booking.newsletter) lines.push("Newsletter: yes");
  if (booking.largeParty) {
    lines.push("", "Large party — the form told them we'll reach out before their visit to confirm the details.");
  }
  lines.push("", `Tracker: https://docs.google.com/spreadsheets/d/${booking.sheetId}/edit`);
  if (booking.manageUrl) lines.push(`Change or cancel (the guest's link): ${booking.manageUrl}`);
  return { subject: oneLine(`${subject}: ${booking.name}, party of ${booking.party} — ${when(booking)}`), text: lines.join("\n") };
};

export const bookingEmail = (booking: Notice): Message =>
  staffEmail(
    "Reservation",
    `${booking.name} booked ${booking.area === "bar" ? "the bar" : "a table"} for ${booking.party}.`,
    booking,
  );

/** `summary` is what changed, as it was noted on the Tracker row. */
export const changedEmail = (booking: Notice, summary: string): Message =>
  staffEmail("Reservation changed", `${booking.name} changed their booking: ${summary}.`, booking);

export const cancelledEmail = (booking: Notice): Message =>
  staffEmail("Reservation cancelled", `${booking.name} cancelled their booking. The row is struck through on the Tracker.`, booking);

/** The email staff get instead when a booking couldn't be written to the Tracker. */
export const unsavedEmail = (booking: Notice, error: unknown): Message => {
  const message = bookingEmail({ ...booking, manageUrl: undefined });
  return {
    subject: oneLine(`NOT ON THE SHEET — ${message.subject}`),
    text: [
      "This booking couldn't be written to the Tracker, so it isn't holding a table. Add it by hand.",
      `The guest was told something went wrong and to email ${CONTACT_EMAIL}, so check for a`,
      "second booking or an email from them before adding it.",
      "",
      message.text,
      "",
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    ].join("\n"),
  };
};

const firstName = (booking: Notice): string => booking.name.trim().split(/\s+/)[0] || "there";

const holding = (booking: Notice): string => {
  const solo = booking.party === 1;
  return booking.area === "bar"
    ? solo ? "a seat at the bar" : `${booking.party} seats at the bar`
    : solo ? "a table for one" : `a table for ${booking.party}`;
};

const guestEmail = (subject: string, body: string[], booking: Notice): Message => {
  const lines = [`Hi ${firstName(booking)},`, "", ...body];
  if (booking.largeParty) {
    lines.push("", "Since you're a larger group, we'll reach out before your visit to confirm the details.");
  }
  if (booking.manageUrl) lines.push("", "Need to change or cancel? Use this link:", booking.manageUrl);
  lines.push("", `Questions? Email us at ${CONTACT_EMAIL}.`, "", "Nice Dream · Sugar Water");
  return { subject: oneLine(subject), text: lines.join("\n") };
};

export const guestBookedEmail = (booking: Notice): Message =>
  guestEmail(
    `Your reservation at Nice Dream — ${when(booking)}`,
    [`You're booked. We're holding ${holding(booking)} on ${when(booking)}.`],
    booking,
  );

export const guestChangedEmail = (booking: Notice): Message =>
  guestEmail(
    `Your reservation at Nice Dream has changed — ${when(booking)}`,
    [`Your reservation is updated. We're now holding ${holding(booking)} on ${when(booking)}.`],
    booking,
  );

export const guestCancelledEmail = (booking: Notice, bookAgainUrl: string): Message =>
  guestEmail(
    `Your reservation at Nice Dream is cancelled — ${when(booking)}`,
    [
      `Your reservation for ${when(booking)} is cancelled. We hope to see you another time — you can book again at:`,
      bookAgainUrl,
    ],
    { ...booking, largeParty: false, manageUrl: undefined },
  );

/** Never rejects: a failed send is only logged, so it can't change what the guest is told. */
export const emailStaff = async (
  email: CarrierEmail,
  recipients: string[],
  message: Message,
  replyTo?: string,
): Promise<void> => {
  const to = recipients.map((address) => address.trim()).filter(Boolean);
  for (let i = 0; i < to.length; i += MAX_RECIPIENTS) {
    try {
      await email.send({ from: NOTIFY_FROM, to: to.slice(i, i + MAX_RECIPIENTS), replyTo, ...message });
    } catch (error) {
      console.error(`Could not email "${message.subject}" to staff:`, error);
    }
  }
};

/** Never rejects, and sends nothing when the guest left a phone number instead of an email. */
export const emailGuest = async (email: CarrierEmail, booking: Notice, message: Message): Promise<void> => {
  if (booking.method !== "Email" || !booking.contact) return;
  try {
    await email.send({ from: NOTIFY_FROM, to: booking.contact, replyTo: CONTACT_EMAIL, ...message });
  } catch (error) {
    console.error(`Could not email "${message.subject}" to the guest:`, error);
  }
};

export const notifyStaff = (
  email: CarrierEmail,
  recipients: string[],
  booking: Notice,
  replyTo?: string,
): Promise<void> => emailStaff(email, recipients, bookingEmail(booking), replyTo);

export const alertUnsaved = (
  email: CarrierEmail,
  recipients: string[],
  booking: Notice,
  error: unknown,
  replyTo?: string,
): Promise<void> => emailStaff(email, recipients, unsavedEmail(booking, error), replyTo);
