/**
 * The email staff get for every booking the form takes, sent to each address in
 * `dinner.reservation_emails`.
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

/** Never rejects: the booking is already on the sheet, so a failed send is only logged. */
export const notifyStaff = async (
  email: CarrierEmail,
  recipients: string[],
  booking: Notice,
  replyTo?: string,
): Promise<void> => {
  const to = recipients.map((address) => address.trim()).filter(Boolean);
  if (!to.length) return;
  const message = bookingEmail(booking);
  for (let i = 0; i < to.length; i += MAX_RECIPIENTS) {
    try {
      await email.send({ from: NOTIFY_FROM, to: to.slice(i, i + MAX_RECIPIENTS), replyTo, ...message });
    } catch (error) {
      console.error("Could not email the booking to staff:", error);
    }
  }
};
