import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CarrierEmail, CarrierEmailMessage } from "@archival/carrier";
import { NOTIFY_FROM, type Notice, alertUnsaved, bookingEmail, notifyStaff, unsavedEmail } from "./notify.ts";

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
      ].join("\n"),
    );
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
    assert.ok(text.includes(bookingEmail(notice({ notes: "No shellfish" })).text));
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
