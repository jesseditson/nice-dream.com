/**
 * The emails a booking sends: a summary to staff — each address in
 * `dinner.reservation_emails` — whenever a booking is taken, changed or
 * cancelled, a louder one when a booking couldn't be written to the Tracker,
 * and a confirmation to the guest with the link that lets them change or
 * cancel it.
 *
 * The copy — subjects, leads, body text — lives on the `emails` object, so it
 * can be edited as content. Placeholders like {name}, {party}, {area}, {when},
 * {holding}, {summary}, {contact}, {book_url} and {error} are filled in here.
 */
import type { CarrierEmail } from "@archival/carrier";
import type { EmailsObject } from "./archival-objects.d.ts";
import { type Area, formatClock, formatDateLabel } from "./room.ts";
import type { NewBooking } from "./sheet.ts";

export const NOTIFY_FROM = "reservation@nice-dream.com";
export const CONTACT_EMAIL = "hello@nice-dream.com";

const MAX_RECIPIENTS = 10;

export type Notice = NewBooking & {
  area: Area;
  largeParty: boolean;
  sheetId: string;
  /** The site's origin, for the images and links in the guest's email. */
  siteUrl: string;
  /** Where the guest can change or cancel the booking; absent when it isn't on the sheet. */
  manageUrl?: string;
};

/** Staff get `text`; the guest's emails carry an `html` version styled like the form. */
export type Message = { subject: string; text: string; html?: string };

/** Fills the {placeholders} in an email copy template with the given values. */
const fill = (template: string | null, vars: Record<string, string>): string =>
  (template ?? "").replace(/\{(\w+)\}/g, (_, key) => (key in vars ? vars[key] : `{${key}}`));

/** An `emails` copy field that holds two lines of a card title, split on "\n". */
const titleLines = (title: string | null): [string, string] => {
  const [a = "", b = ""] = (title ?? "").split("\n");
  return [a, b];
};

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

const when = (booking: Notice): string => `${formatDateLabel(booking.date)} at ${formatClock(booking.start)}`;

const seating = (booking: Notice): string => {
  const plural = booking.tables.length > 1;
  return booking.area === "bar"
    ? `Bar, ${plural ? "seats" : "seat"} ${booking.tables.join(", ")}`
    : `Dining room, ${plural ? "tables" : "table"} ${booking.tables.join(", ")}`;
};

/** The booking as staff see it, under a lead line. */
const staffEmail = (emails: EmailsObject, subject: string | null, lead: string, booking: Notice): Message => {
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
  return {
    subject: oneLine(`${subject}: ${booking.name}, party of ${booking.party} — ${when(booking)}`),
    text: lines.join("\n"),
  };
};

export const bookingEmail = (emails: EmailsObject, booking: Notice): Message =>
  staffEmail(
    emails,
    emails.staff_booked_subject,
    fill(emails.staff_booked_lead, {
      name: booking.name,
      party: String(booking.party),
      area: booking.area === "bar" ? "the bar" : "a table",
    }),
    booking,
  );

/** `summary` is what changed, as it was noted on the Tracker row. */
export const changedEmail = (emails: EmailsObject, booking: Notice, summary: string): Message =>
  staffEmail(
    emails,
    emails.staff_changed_subject,
    fill(emails.staff_changed_lead, { name: booking.name, summary }),
    booking,
  );

export const cancelledEmail = (emails: EmailsObject, booking: Notice): Message =>
  staffEmail(
    emails,
    emails.staff_cancelled_subject,
    fill(emails.staff_cancelled_lead, { name: booking.name }),
    booking,
  );

/** The email staff get instead when a booking couldn't be written to the Tracker. */
export const unsavedEmail = (emails: EmailsObject, booking: Notice, error: unknown): Message => {
  const message = bookingEmail(emails, { ...booking, manageUrl: undefined });
  return {
    subject: oneLine(`${emails.unsaved_subject_prefix}${message.subject}`),
    text: [
      fill(emails.unsaved_alert, { contact: CONTACT_EMAIL }),
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

// ---- the guest's email, styled like the form ----------------------------------

const INK = "#161410";
const INK_70 = "#4a463f";
const INK_50 = "#76716a";
const INK_30 = "#a8a299";
const BODY_FONT = "'Nunito', 'Avenir Next', 'Avenir', Helvetica, Arial, sans-serif";
const TITLE_FONT = `'Perrrot', ${BODY_FONT}`;

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);

const site = (booking: Notice, path: string): string => `${booking.siteUrl.replace(/\/+$/, "")}${path}`;

type Card = {
  /** `nd-confirm-dog` (curled up asleep) or `nd-hero-dog` (fork and spoon at the ready). */
  dog: "confirm" | "hero";
  /** Two lines, like the form's "You're / booked." */
  title: [string, string];
  /** HTML — already escaped. */
  lead: string;
  details?: [string, string][];
  largeParty?: boolean;
  button?: { label: string; url: string };
  /** The note under the button; HTML. */
  aside: string;
  footmark: string;
};

const label = (text: string): string =>
  `<span style="font-family:${TITLE_FONT};font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:${INK_50};">${text}</span>`;

const detailRows = (details: [string, string][]): string =>
  details
    .map(
      ([name, value], index) =>
        `<tr><td style="padding:11px 16px 10px;${index ? `border-top:1.5px solid ${INK};` : ""}">` +
        `<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>` +
        `<td style="width:84px;vertical-align:top;padding-top:2px;">${label(name)}</td>` +
        `<td style="font-family:${BODY_FONT};font-size:15px;line-height:1.5;font-weight:700;color:${INK};">${escapeHtml(value)}</td>` +
        `</tr></table></td></tr>`,
    )
    .join("");

const wave = `<div style="font-family:${BODY_FONT};font-size:15px;line-height:1;letter-spacing:0.18em;white-space:nowrap;overflow:hidden;color:${INK};" aria-hidden="true">~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~</div>`;

const cardHtml = (emails: EmailsObject, booking: Notice, card: Card): string => {
  const paragraph = `font-family:${BODY_FONT};font-size:15px;line-height:1.75;color:${INK_70};`;
  const sections = [
    `<tr><td align="center" style="padding:0 0 14px;"><img src="${site(booking, `/img/nd-${card.dog}-dog.png`)}" width="150" height="150" alt="" style="display:block;width:150px;height:150px;border:0;"></td></tr>`,
    `<tr><td align="center" style="font-family:${TITLE_FONT};font-size:34px;line-height:1.1;letter-spacing:0.06em;text-transform:uppercase;font-weight:700;color:${INK};padding:0 0 18px;">${card.title[0]}<br>${card.title[1]}</td></tr>`,
    `<tr><td align="center" style="padding:0 0 20px;">${wave}</td></tr>`,
    `<tr><td style="${paragraph}">${card.lead}</td></tr>`,
  ];
  if (card.details?.length) {
    sections.push(
      `<tr><td style="padding:20px 0 0;"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1.5px solid ${INK};border-radius:11px;">${detailRows(card.details)}</table></td></tr>`,
    );
  }
  if (card.largeParty) {
    sections.push(
      `<tr><td style="padding:16px 0 0;"><div style="border:1.5px solid ${INK};border-radius:11px;background:#fbf7ee;padding:12px 15px;${paragraph}font-size:13px;line-height:1.65;">${escapeHtml(emails.large_party_note ?? "")}</div></td></tr>`,
    );
  }
  if (card.button) {
    sections.push(
      `<tr><td align="center" style="padding:24px 0 0;"><a href="${escapeHtml(card.button.url)}" style="display:inline-block;font-family:${TITLE_FONT};font-size:15px;letter-spacing:0.12em;text-transform:uppercase;font-weight:700;color:#ffffff;background:${INK};border:1.5px solid ${INK};border-radius:13px;padding:14px 28px;text-decoration:none;">${card.button.label}</a></td></tr>`,
    );
  }
  sections.push(
    `<tr><td align="center" style="padding:${card.button ? 12 : 22}px 0 0;font-family:${BODY_FONT};font-size:12.5px;line-height:1.7;font-style:italic;color:${INK_50};">${card.aside}</td></tr>`,
  );
  const link = (url: string, text: string): string =>
    `<a href="${escapeHtml(url)}" style="color:${INK};text-decoration:underline;">${text}</a>`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<style>@font-face{font-family:'Perrrot';src:url('${site(booking, "/fonts/perrrot.otf")}') format('opentype');font-weight:normal;font-style:normal;}</style>` +
    `<title>${escapeHtml(card.title.join(" "))}</title></head>` +
    `<body style="margin:0;padding:0;background:#ffffff;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#ffffff;"><tr><td align="center" style="padding:36px 16px 48px;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:520px;">` +
    `<tr><td align="center" style="padding:0 0 22px;">${link(site(booking, "/"), `<img src="${site(booking, "/img/nice-dream-logo.png")}" width="184" alt="Nice Dream" style="display:block;width:184px;height:auto;border:0;">`)}</td></tr>` +
    `<tr><td style="background:#ffffff;border:1.5px solid ${INK};border-radius:18px;padding:36px 32px 30px;box-shadow:7px 9px 0 rgba(22,20,16,0.9);">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%">${sections.join("")}</table>` +
    `</td></tr>` +
    `<tr><td align="center" style="padding:26px 0 0;font-family:${TITLE_FONT};font-size:11px;letter-spacing:0.3em;text-transform:uppercase;color:${INK_30};">${card.footmark}</td></tr>` +
    `</table></td></tr></table></body></html>`
  );
};

const whereLabel = (booking: Notice): string => (booking.area === "bar" ? "Sugar Water, our bar" : "The dining room");

const guestEmail = (emails: EmailsObject, subject: string, body: string[], booking: Notice, card: Card): Message => {
  const lines = [`Hi ${firstName(booking)},`, "", ...body];
  if (booking.largeParty) lines.push("", emails.large_party_note ?? "");
  if (booking.manageUrl) lines.push("", emails.manage_note ?? "", booking.manageUrl);
  lines.push("", fill(emails.questions, { contact: CONTACT_EMAIL }), "", emails.signoff ?? "");
  return { subject: oneLine(subject), text: lines.join("\n"), html: cardHtml(emails, booking, card) };
};

const strong = (text: string): string => `<strong style="color:${INK};">${escapeHtml(text)}</strong>`;

/** The questions line, with {contact} turned into a mailto link for the HTML card. */
const askUsHtml = (emails: EmailsObject): string =>
  fill(emails.questions, { contact: `<a href="mailto:${CONTACT_EMAIL}" style="color:${INK};text-decoration:underline;">${CONTACT_EMAIL}</a>` });

const manageAside = (emails: EmailsObject, booking: Notice): string =>
  booking.manageUrl ? `The button above lets you change or cancel any time. ${askUsHtml(emails)}` : askUsHtml(emails);

const heldCard = (emails: EmailsObject, booking: Notice, title: [string, string], lead: string, footmark: string): Card => ({
  dog: "confirm",
  title,
  lead,
  details: [
    ["When", when(booking)],
    ["Party", String(booking.party)],
    ["Where", whereLabel(booking)],
  ],
  largeParty: booking.largeParty,
  ...(booking.manageUrl ? { button: { label: emails.button_change_label ?? "", url: booking.manageUrl } } : {}),
  aside: manageAside(emails, booking),
  footmark,
});

export const guestBookedEmail = (emails: EmailsObject, booking: Notice): Message =>
  guestEmail(
    emails,
    fill(emails.guest_booked_subject, { when: when(booking) }),
    [fill(emails.guest_booked_body, { holding: holding(booking), when: when(booking) })],
    booking,
    heldCard(
      emails,
      booking,
      titleLines(emails.guest_booked_title),
      fill(emails.guest_booked_lead, {
        name: strong(firstName(booking)),
        holding: holding(booking),
        when: when(booking),
      }),
      emails.guest_booked_footmark ?? "",
    ),
  );

export const guestChangedEmail = (emails: EmailsObject, booking: Notice): Message =>
  guestEmail(
    emails,
    fill(emails.guest_changed_subject, { when: when(booking) }),
    [fill(emails.guest_changed_body, { holding: holding(booking), when: when(booking) })],
    booking,
    heldCard(
      emails,
      booking,
      titleLines(emails.guest_changed_title),
      fill(emails.guest_changed_lead, {
        name: strong(firstName(booking)),
        holding: holding(booking),
        when: when(booking),
      }),
      emails.guest_changed_footmark ?? "",
    ),
  );

export const guestCancelledEmail = (emails: EmailsObject, booking: Notice, bookAgainUrl: string): Message =>
  guestEmail(
    emails,
    fill(emails.guest_cancelled_subject, { when: when(booking) }),
    [fill(emails.guest_cancelled_body, { when: when(booking), book_url: bookAgainUrl }), bookAgainUrl],
    { ...booking, largeParty: false, manageUrl: undefined },
    {
      dog: "hero",
      title: titleLines(emails.guest_cancelled_title),
      lead: fill(emails.guest_cancelled_lead, { name: strong(firstName(booking)), when: when(booking) }),
      button: { label: emails.button_book_again_label ?? "", url: bookAgainUrl },
      aside: askUsHtml(emails),
      footmark: emails.guest_cancelled_footmark ?? "",
    },
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
  emails: EmailsObject,
  email: CarrierEmail,
  recipients: string[],
  booking: Notice,
  replyTo?: string,
): Promise<void> => emailStaff(email, recipients, bookingEmail(emails, booking), replyTo);

export const alertUnsaved = (
  emails: EmailsObject,
  email: CarrierEmail,
  recipients: string[],
  booking: Notice,
  error: unknown,
  replyTo?: string,
): Promise<void> => emailStaff(email, recipients, unsavedEmail(emails, booking, error), replyTo);