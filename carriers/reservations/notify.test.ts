import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CarrierEmail, CarrierEmailMessage } from "@archival/carrier";
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
  manageUrl: "https://nice-dream.com/reservations.html?token=KEY",
  ...overrides,
});

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
    const { subject, text } = bookingEmail(notice({ notes: "No shellfish", newsletter: true }));
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
    assert.doesNotMatch(bookingEmail(notice({ manageUrl: undefined })).text, /Change or cancel/);
  });

  test("names bar seats and a single table", () => {
    const bar = bookingEmail(notice({ area: "bar", tables: ["B1", "B2"] })).text;
    assert.match(bar, /^Ada Lovelace booked the bar for 4\.$/m);
    assert.match(bar, /^Seating: Bar, seats B1, B2$/m);
    assert.match(bookingEmail(notice({ tables: ["C1"] })).text, /^Seating: Dining room, table C1$/m);
  });

  test("flags a large party", () => {
    assert.match(bookingEmail(notice({ largeParty: true })).text, /Large party/);
    assert.doesNotMatch(bookingEmail(notice()).text, /Large party/);
  });

  test("keeps a multi-line name out of the subject's line breaks", () => {
    assert.doesNotMatch(bookingEmail(notice({ name: "Ada\r\nBcc: x@example.com" })).subject, /[\r\n]/);
  });
});

describe("changedEmail", () => {
  test("leads with what changed", () => {
    const { subject, text } = changedEmail(notice({ party: 4 }), "party 2 → 4, time 6:00 PM → 6:30 PM");
    assert.equal(subject, "Reservation changed: Ada Lovelace, party of 4 — Thursday, October 8th at 6:30 PM");
    assert.match(text, /^Ada Lovelace changed their booking: party 2 → 4, time 6:00 PM → 6:30 PM\.$/m);
    assert.match(text, /^Seating: Dining room, tables 5, 6$/m);
  });
});

describe("cancelledEmail", () => {
  test("says the row is struck through", () => {
    const { subject, text } = cancelledEmail(notice());
    assert.equal(subject, "Reservation cancelled: Ada Lovelace, party of 4 — Thursday, October 8th at 6:30 PM");
    assert.match(text, /^Ada Lovelace cancelled their booking\. The row is struck through on the Tracker\.$/m);
  });
});

describe("guest emails", () => {
  test("confirm the booking with the edit link, by first name", () => {
    const { subject, text } = guestBookedEmail(notice());
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
    assert.match(guestBookedEmail(notice({ area: "bar", party: 1, tables: ["B1"] })).text, /holding a seat at the bar/);
    assert.match(guestBookedEmail(notice({ area: "bar", party: 2, tables: ["B1", "B2"] })).text, /holding 2 seats at the bar/);
    assert.match(guestBookedEmail(notice({ party: 1, tables: ["5"] })).text, /holding a table for one/);
    assert.match(guestBookedEmail(notice({ largeParty: true })).text, /we'll reach out before your visit/);
  });

  test("say what a change left them with", () => {
    const { subject, text } = guestChangedEmail(notice({ party: 2, tables: ["5"] }));
    assert.match(subject, /^Your reservation at Nice Dream has changed/);
    assert.match(text, /We're now holding a table for 2 on Thursday, October 8th at 6:30 PM\./);
    assert.match(text, /Need to change or cancel\?/);
  });

  test("confirm a cancellation with a way to book again, and no edit link", () => {
    const { subject, text } = guestCancelledEmail(notice({ largeParty: true }), "https://nice-dream.com/reservations.html");
    assert.match(subject, /^Your reservation at Nice Dream is cancelled/);
    assert.match(text, /is cancelled\. We hope to see you another time/);
    assert.match(text, /^https:\/\/nice-dream\.com\/reservations\.html$/m);
    assert.doesNotMatch(text, /Need to change or cancel/);
    assert.doesNotMatch(text, /larger group/);
  });
});

describe("emailGuest", () => {
  test("sends to the guest's email, with replies going to the restaurant", async () => {
    const { email, sent } = recorder();
    await emailGuest(email, notice(), guestBookedEmail(notice()));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].from, NOTIFY_FROM);
    assert.equal(sent[0].to, "ada@example.com");
    assert.equal(sent[0].replyTo, CONTACT_EMAIL);
  });

  test("sends nothing to a guest who left a phone number", async () => {
    const { email, sent } = recorder();
    await emailGuest(email, notice({ method: "Text (SMS)", contact: "5550100" }), guestBookedEmail(notice()));
    assert.equal(sent.length, 0);
  });

  test("resolves even when sending fails", async () => {
    const { email } = recorder(true);
    const logged = console.error;
    console.error = () => {};
    try {
      await assert.doesNotReject(emailGuest(email, notice(), guestBookedEmail(notice())));
    } finally {
      console.error = logged;
    }
  });
});

describe("notifyStaff", () => {
  test("sends one message from the reservations address to every recipient", async () => {
    const { email, sent } = recorder();
    await notifyStaff(email, ["jesse@nice-dream.com", " ren@nice-dream.com ", ""], notice(), "ada@example.com");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].from, NOTIFY_FROM);
    assert.deepEqual(sent[0].to, ["jesse@nice-dream.com", "ren@nice-dream.com"]);
    assert.equal(sent[0].replyTo, "ada@example.com");
  });

  test("sends nothing when no one is listed", async () => {
    const { email, sent } = recorder();
    await notifyStaff(email, ["", "  "], notice());
    assert.equal(sent.length, 0);
  });

  test("splits more than ten recipients across messages", async () => {
    const { email, sent } = recorder();
    const staff = Array.from({ length: 12 }, (_, i) => `staff${i}@nice-dream.com`);
    await notifyStaff(email, staff, notice());
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
      await assert.doesNotReject(notifyStaff(email, ["jesse@nice-dream.com"], notice()));
    } finally {
      console.error = logged;
    }
  });
});

describe("unsavedEmail", () => {
  test("flags the booking as missing from the sheet and carries everything needed to add it", () => {
    const { subject, text } = unsavedEmail(notice({ notes: "No shellfish" }), new Error("Sheets POST → 503: backend"));
    assert.equal(
      subject,
      "NOT ON THE SHEET — Reservation: Ada Lovelace, party of 4 — Thursday, October 8th at 6:30 PM",
    );
    assert.match(text, /^This booking couldn't be written to the Tracker/);
    assert.ok(text.includes(bookingEmail(notice({ notes: "No shellfish", manageUrl: undefined })).text));
    assert.doesNotMatch(text, /Change or cancel/);
    assert.match(text, /^Error: Sheets POST → 503: backend$/m);
  });
});

describe("alertUnsaved", () => {
  test("sends the alert from the reservations address to every recipient", async () => {
    const { email, sent } = recorder();
    await alertUnsaved(email, ["jesse@nice-dream.com", "ren@nice-dream.com"], notice(), "boom", "ada@example.com");
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
      await assert.doesNotReject(alertUnsaved(email, ["jesse@nice-dream.com"], notice(), "boom"));
    } finally {
      console.error = logged;
    }
  });
});
