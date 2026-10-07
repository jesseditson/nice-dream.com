/**
 * The email staff get for every booking the form takes, sent to each address in
 * `dinner.reservation_emails` — and the louder one they get when a booking
 * couldn't be written to the Tracker.
 */
import type { CarrierEmail } from "@archival/carrier";
import { type Area, formatClock, formatDateLabel } from "./room.ts";
import type { NewBooking } from "./sheet.ts";

export const NOTIFY_FROM = "reservation@nice-dream.com";

const MAX_RECIPIENTS = 10;

export type Notice = NewBooking & {
  area: Area;
  largeParty: boolean;
  sheetId: string;
};

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

export const bookingEmail = (booking: Notice): { subject: string; text: string } => {
  const when = `${formatDateLabel(booking.date)} at ${formatClock(booking.start)}`;
  const plural = booking.tables.length > 1;
  const where =
    booking.area === "bar"
      ? `Bar, ${plural ? "seats" : "seat"} ${booking.tables.join(", ")}`
      : `Dining room, ${plural ? "tables" : "table"} ${booking.tables.join(", ")}`;
  const lines = [
    `${booking.name} booked ${booking.area === "bar" ? "the bar" : "a table"} for ${booking.party}.`,
    "",
    `When: ${when}`,
    `Party: ${booking.party}`,
    `Seating: ${where}`,
    `${booking.method}: ${booking.contact}`,
  ];
  if (booking.notes) lines.push(`Notes: ${booking.notes}`);
  if (booking.newsletter) lines.push("Newsletter: yes");
  if (booking.largeParty) {
    lines.push("", "Large party — the form told them we'll reach out before their visit to confirm the details.");
  }
  lines.push("", `Tracker: https://docs.google.com/spreadsheets/d/${booking.sheetId}/edit`);
  return {
    subject: oneLine(`Reservation: ${booking.name}, party of ${booking.party} — ${when}`),
    text: lines.join("\n"),
  };
};

/** The email staff get instead when a booking couldn't be written to the Tracker. */
export const unsavedEmail = (booking: Notice, error: unknown): { subject: string; text: string } => {
  const message = bookingEmail(booking);
  return {
    subject: oneLine(`NOT ON THE SHEET — ${message.subject}`),
    text: [
      "This booking couldn't be written to the Tracker, so it isn't holding a table. Add it by hand.",
      "The guest was told something went wrong and to email hello@nice-dream.com, so check for a",
      "second booking or an email from them before adding it.",
      "",
      message.text,
      "",
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    ].join("\n"),
  };
};

/** Never rejects: a failed send is only logged, so it can't change what the guest is told. */
const sendToStaff = async (
  email: CarrierEmail,
  recipients: string[],
  message: { subject: string; text: string },
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

export const notifyStaff = (
  email: CarrierEmail,
  recipients: string[],
  booking: Notice,
  replyTo?: string,
): Promise<void> => sendToStaff(email, recipients, bookingEmail(booking), replyTo);

export const alertUnsaved = (
  email: CarrierEmail,
  recipients: string[],
  booking: Notice,
  error: unknown,
  replyTo?: string,
): Promise<void> => sendToStaff(email, recipients, unsavedEmail(booking, error), replyTo);
