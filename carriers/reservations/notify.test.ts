import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CarrierEmail, CarrierEmailMessage } from "@archival/carrier";
import type { EmailsObject } from "./archival-objects.d.ts";
import {
  CONTACT_EMAIL,
  NOTIFY_FROM,
  type Notice,
  alertUnsaved,
  bookingEmail,
  cancelledEmail,
  changedEmail,
  emailGuest,
  guestBookedEmail,
  guestCancelledEmail,
  guestChangedEmail,
  notifyStaff,
  unsavedEmail,
} from "./notify.ts";

const notice = (overrides: Partial<Notice> = {}): Notice => ({
  date: "2026-10-08",
  start: 18 * 60 + 30,
  tables: ["5", "6"],
  party: 4,
  name: "Ada Lovelace",
  method: "Email",
  contact: "ada@example.com",
  notes: "",
  newsletter: false,
  area: "dining",
  largeParty: false,
  sheetId: "SHEET",
  siteUrl: "https://nice-dream.com",
  manageUrl: "https://nice-dream.com/reservations.html?token=KEY",
  ...overrides,
});

/** The copy exactly as `objects/emails.toml` ships it; editing one shouldn't break the other. */
const emails: EmailsObject = {
  path: "emails",
  order: null,
  staff_booked_subject: "Reservation",
  staff_changed_subject: "Reservation changed",
  staff_cancelled_subject: "Reservation cancelled",
  staff_booked_lead: "{name} booked {area} for {party}.",
  staff_changed_lead: "{name} changed their booking: {summary}.",
  staff_cancelled_lead: "{name} cancelled their booking. The row is struck through on the Tracker.",
  unsaved_subject_prefix: "NOT ON THE SHEET — ",
  unsaved_alert:
    "This booking couldn't be written to the Tracker, so it isn't holding a table. Add it by hand.\n" +
    "The guest was told something went wrong and to email {contact}, so check for a second booking or an email from them before adding it.",
  large_party_note: "Since you're a larger group, we'll reach out before your visit to confirm the details.",
  manage_note: "Need to change or cancel? Use this link:",
  questions: "Questions? Email us at {contact}.",
  signoff: "Nice Dream · Sugar Water",
  button_change_label: "Change or cancel",
  button_book_again_label: "Book again",
  guest_booked_subject: "Your reservation at Nice Dream — {when}",
  guest_booked_body: "You're booked. We're holding {holding} on {when}.",
  guest_booked_title: "You're\nbooked.",
  guest_booked_lead: "See you soon, {name} — we're holding {holding} on {when}.",
  guest_booked_footmark: "Sweet dreams · See you soon",
  guest_changed_subject: "Your reservation at Nice Dream has changed — {when}",
  guest_changed_body: "Your reservation is updated. We're now holding {holding} on {when}.",
  guest_changed_title: "All\nupdated.",
  guest_changed_lead: "Got it, {name} — we're now holding {holding} on {when}.",
  guest_changed_footmark: "Sweet dreams · See you soon",
  guest_cancelled_subject: "Your reservation at Nice Dream is cancelled — {when}",
  guest_cancelled_body:
    "Your reservation for {when} is cancelled. We hope to see you another time — you can book again at:",
  guest_cancelled_title: "Reservation\ncancelled.",
  guest_cancelled_lead:
    "No worries, {name} — your reservation for {when} is cancelled. We'll keep a fork and spoon ready for next time.",
  guest_cancelled_footmark: "Sweet dreams · Until next time",
};

const recorder = (fail = false): { email: CarrierEmail; sent: CarrierEmailMessage[] } => {
  const sent: CarrierEmailMessage[] = [];
  return {
    sent,
    email: {
      send: async (message) => {
        sent.push(message);
        if (fail) throw new Error("over the hourly limit");
        return { id: String(sent.length), from: message.from ?? "" };
      },
    },
  };
};

describe("bookingEmail", () => {
  test("summarizes the booking", () => {
    const { subject, text } = bookingEmail(emails, notice({ notes: "No shellfish", newsletter: true }));
    assert.equal(subject, "Reservation: Ada Lovelace, party of 4 — Thursday, October 8th at 6:30 PM");
    assert.equal(
      text,
      [
        "Ada Lovelace booked a table for 4.",
        "",
        "When: Thursday, October 8th at 6:30 PM",
        "Party: 4",
        "Seating: Dining room, tables 5, 6",
        "Email: ada@example.com",
        "Notes: No shellfish",
        "Newsletter: yes",
        "",
        "Tracker: https://docs.google.com/spreadsheets/d/SHEET/edit",
        "Change or cancel (the guest's link): https://nice-dream.com/reservations.html?token=KEY",
      ].join("\n"),
    );
  });

  test("leaves the link out when the booking has none", () => {
    assert.doesNotMatch(bookingEmail(emails, notice({ manageUrl: undefined })).text, /Change or cancel/);
  });

  test("names bar seats and a single table", () => {
    const bar = bookingEmail(emails, notice({ area: "bar", tables: ["B1", "B2"] })).text;
    assert.match(bar, /^Ada Lovelace booked the bar for 4\.$/m);
    assert.match(bar, /^Seating: Bar, seats B1, B2$/m);
    assert.match(bookingEmail(emails, notice({ tables: ["C1"] })).text, /^Seating: Dining room, table C1$/m);
  });

  test("flags a large party", () => {
    assert.match(bookingEmail(emails, notice({ largeParty: true })).text, /Large party/);
    assert.doesNotMatch(bookingEmail(emails, notice()).text, /Large party/);
  });

  test("keeps a multi-line name out of the subject's line breaks", () => {
    assert.doesNotMatch(bookingEmail(emails, notice({ name: "Ada\r\nBcc: x@example.com" })).subject, /[\r\n]/);
  });
});

describe("changedEmail", () => {
  test("leads with what changed", () => {
    const { subject, text } = changedEmail(emails, notice({ party: 4 }), "party 2 → 4, time 6:00 PM → 6:30 PM");
    assert.equal(subject, "Reservation changed: Ada Lovelace, party of 4 — Thursday, October 8th at 6:30 PM");
    assert.match(text, /^Ada Lovelace changed their booking: party 2 → 4, time 6:00 PM → 6:30 PM\.$/m);
    assert.match(text, /^Seating: Dining room, tables 5, 6$/m);
  });
});

describe("cancelledEmail", () => {
  test("says the row is struck through", () => {
    const { subject, text } = cancelledEmail(emails, notice());
    assert.equal(subject, "Reservation cancelled: Ada Lovelace, party of 4 — Thursday, October 8th at 6:30 PM");
    assert.match(text, /^Ada Lovelace cancelled their booking\. The row is struck through on the Tracker\.$/m);
  });
});

describe("guest emails", () => {
  test("confirm the booking with the edit link, by first name", () => {
    const { subject, text } = guestBookedEmail(emails, notice());
    assert.equal(subject, "Your reservation at Nice Dream — Thursday, October 8th at 6:30 PM");
    assert.equal(
      text,
      [
        "Hi Ada,",
        "",
        "You're booked. We're holding a table for 4 on Thursday, October 8th at 6:30 PM.",
        "",
        "Need to change or cancel? Use this link:",
        "https://nice-dream.com/reservations.html?token=KEY",
        "",
        `Questions? Email us at ${CONTACT_EMAIL}.`,
        "",
        "Nice Dream · Sugar Water",
      ].join("\n"),
    );
  });

  test("describe bar seats, a table for one, and a large party", () => {
    assert.match(guestBookedEmail(emails, notice({ area: "bar", party: 1, tables: ["B1"] })).text, /holding a seat at the bar/);
    assert.match(guestBookedEmail(emails, notice({ area: "bar", party: 2, tables: ["B1", "B2"] })).text, /holding 2 seats at the bar/);
    assert.match(guestBookedEmail(emails, notice({ party: 1, tables: ["5"] })).text, /holding a table for one/);
    assert.match(guestBookedEmail(emails, notice({ largeParty: true })).text, /we'll reach out before your visit/);
  });

  test("say what a change left them with", () => {
    const { subject, text } = guestChangedEmail(emails, notice({ party: 2, tables: ["5"] }));
    assert.match(subject, /^Your reservation at Nice Dream has changed/);
    assert.match(text, /We're now holding a table for 2 on Thursday, October 8th at 6:30 PM\./);
    assert.match(text, /Need to change or cancel\?/);
  });

  test("confirm a cancellation with a way to book again, and no edit link", () => {
    const { subject, text } = guestCancelledEmail(emails, notice({ largeParty: true }), "https://nice-dream.com/reservations.html");
    assert.match(subject, /^Your reservation at Nice Dream is cancelled/);
    assert.match(text, /is cancelled\. We hope to see you another time/);
    assert.match(text, /^https:\/\/nice-dream\.com\/reservations\.html$/m);
    assert.doesNotMatch(text, /Need to change or cancel/);
    assert.doesNotMatch(text, /larger group/);
  });
});

describe("guest email html", () => {
  test("is styled like the form, with the site's images and the edit button", () => {
    const html = guestBookedEmail(emails, notice()).html ?? "";
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /src="https:\/\/nice-dream\.com\/img\/nice-dream-logo\.png"/);
    assert.match(html, /src="https:\/\/nice-dream\.com\/img\/nd-confirm-dog\.png"/);
    assert.match(html, /url\('https:\/\/nice-dream\.com\/fonts\/perrrot\.otf'\)/);
    assert.match(html, /You're<br>booked\./);
    assert.match(html, /<a href="https:\/\/nice-dream\.com\/reservations\.html\?token=KEY"[^>]*>Change or cancel<\/a>/);
    assert.match(html, /Thursday, October 8th at 6:30 PM/);
    assert.match(html, /The dining room/);
    assert.match(guestBookedEmail(emails, notice({ area: "bar", tables: ["B1"] })).html ?? "", /Sugar Water, our bar/);
  });

  test("escapes what the guest typed", () => {
    const html = guestBookedEmail(emails, notice({ name: "<b>Ada</b> & co" })).html ?? "";
    assert.match(html, /&lt;b&gt;Ada&lt;\/b&gt;/);
    assert.doesNotMatch(html, /<b>Ada/);
  });

  test("the cancellation uses the other dog, a book-again button and no edit link", () => {
    const html = guestCancelledEmail(emails, notice(), "https://nice-dream.com/reservations.html").html ?? "";
    assert.match(html, /nd-hero-dog\.png/);
    assert.match(html, /Reservation<br>cancelled\./);
    assert.match(html, /<a href="https:\/\/nice-dream\.com\/reservations\.html"[^>]*>Book again<\/a>/);
    assert.doesNotMatch(html, /token=KEY/);
  });

  test("staff emails stay plain text", () => {
    assert.equal(bookingEmail(emails, notice()).html, undefined);
    assert.equal(changedEmail(emails, notice(), "party 2 → 4").html, undefined);
  });
});

describe("emailGuest", () => {
  test("sends to the guest's email, with replies going to the restaurant", async () => {
    const { email, sent } = recorder();
    await emailGuest(email, notice(), guestBookedEmail(emails, notice()));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].from, NOTIFY_FROM);
    assert.equal(sent[0].to, "ada@example.com");
    assert.equal(sent[0].replyTo, CONTACT_EMAIL);
    assert.match(sent[0].html ?? "", /^<!doctype html>/);
    assert.match(sent[0].text ?? "", /^Hi Ada,/);
  });

  test("sends nothing to a guest who left a phone number", async () => {
    const { email, sent } = recorder();
    await emailGuest(email, notice({ method: "Text (SMS)", contact: "5550100" }), guestBookedEmail(emails, notice()));
    assert.equal(sent.length, 0);
  });

  test("resolves even when sending fails", async () => {
    const { email } = recorder(true);
    const logged = console.error;
    console.error = () => {};
    try {
      await assert.doesNotReject(emailGuest(email, notice(), guestBookedEmail(emails, notice())));
    } finally {
      console.error = logged;
    }
  });
});

describe("notifyStaff", () => {
  test("sends one message from the reservations address to every recipient", async () => {
    const { email, sent } = recorder();
    await notifyStaff(emails, email, ["jesse@nice-dream.com", " ren@nice-dream.com ", ""], notice(), "ada@example.com");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].from, NOTIFY_FROM);
    assert.deepEqual(sent[0].to, ["jesse@nice-dream.com", "ren@nice-dream.com"]);
    assert.equal(sent[0].replyTo, "ada@example.com");
  });

  test("sends nothing when no one is listed", async () => {
    const { email, sent } = recorder();
    await notifyStaff(emails, email, ["", "  "], notice());
    assert.equal(sent.length, 0);
  });

  test("splits more than ten recipients across messages", async () => {
    const { email, sent } = recorder();
    const staff = Array.from({ length: 12 }, (_, i) => `staff${i}@nice-dream.com`);
    await notifyStaff(emails, email, staff, notice());
    assert.deepEqual(
      sent.map((message) => message.to),
      [staff.slice(0, 10), staff.slice(10)],
    );
  });

  test("resolves even when sending fails", async () => {
    const { email } = recorder(true);
    const logged = console.error;
    console.error = () => {};
    try {
      await assert.doesNotReject(notifyStaff(emails, email, ["jesse@nice-dream.com"], notice()));
    } finally {
      console.error = logged;
    }
  });
});

describe("unsavedEmail", () => {
  test("flags the booking as missing from the sheet and carries everything needed to add it", () => {
    const { subject, text } = unsavedEmail(emails, notice({ notes: "No shellfish" }), new Error("Sheets POST → 503: backend"));
    assert.equal(
      subject,
      "NOT ON THE SHEET — Reservation: Ada Lovelace, party of 4 — Thursday, October 8th at 6:30 PM",
    );
    assert.match(text, /^This booking couldn't be written to the Tracker/);
    assert.ok(text.includes(bookingEmail(emails, notice({ notes: "No shellfish", manageUrl: undefined })).text));
    assert.doesNotMatch(text, /Change or cancel/);
    assert.match(text, /^Error: Sheets POST → 503: backend$/m);
  });
});

describe("alertUnsaved", () => {
  test("sends the alert from the reservations address to every recipient", async () => {
    const { email, sent } = recorder();
    await alertUnsaved(emails, email, ["jesse@nice-dream.com", "ren@nice-dream.com"], notice(), "boom", "ada@example.com");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].from, NOTIFY_FROM);
    assert.deepEqual(sent[0].to, ["jesse@nice-dream.com", "ren@nice-dream.com"]);
    assert.equal(sent[0].replyTo, "ada@example.com");
    assert.match(sent[0].subject ?? "", /^NOT ON THE SHEET — /);
    assert.match(sent[0].text ?? "", /^Error: boom$/m);
  });

  test("resolves even when sending fails", async () => {
    const { email } = recorder(true);
    const logged = console.error;
    console.error = () => {};
    try {
      await assert.doesNotReject(alertUnsaved(emails, email, ["jesse@nice-dream.com"], notice(), "boom"));
    } finally {
      console.error = logged;
    }
  });
});
