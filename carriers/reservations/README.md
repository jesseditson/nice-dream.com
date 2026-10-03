# carriers/reservations

Backs the dinner reservation form at `/reservations.html`. Deployed with the
site and reachable at `/carriers/reservations`.

| | |
| --- | --- |
| `GET` | every seating in the booking window, and which party sizes each can still take |
| `POST` | takes a booking — JSON or a form post |

A `GET` answers with one entry per service night:

```json
{
  "ok": true,
  "today": "2026-10-02",
  "max_party": 8,
  "large_party_min": 6,
  "dates": [
    {
      "date": "2026-10-02",
      "label": "Friday, October 2nd",
      "slots": [
        { "time": "17:30", "label": "5:30 PM", "two": true, "four": false, "communal": true }
      ]
    }
  ]
}
```

`two`, `four` and `communal` say whether a 2-top, a combined 4-top, or a
communal table is free for that seating, so the form answers every party size
from one request.

A `POST` body is `{ party_size, date, time, name, contact_method, email?,
phone?, notes?, newsletter? }` — `time` as `HH:MM`, `contact_method` as `email`
or `sms`, and the matching `email`/`phone` filled in. Anything the guest can fix
comes back as `{ ok: false, error }` with a 200 so the form can show it; only a
misconfigured site throws. Availability is checked again inside the `POST`, so a
form left open overnight can't book a table that filled up. Sheets has no
transactions, so two bookings landing in the very same instant can both pass;
at this size that's a thing to reconcile by hand, not to engineer around.

## Rules

Everything the carrier decides with lives on the `dinner` object
(`objects/dinner.toml`; field notes in `archival_objects.toml`):

- Seatings run every `slot_minutes` from `first` to `last` in each `[[seatings]]`
  block, and a booking holds its table for `hold_minutes`.
- The form offers `weekends_ahead` service weeks, counting the current week
  only if it still has a night left. Tonight is offered until the last seating.
- The room has `two_tops` 2-tops, numbered from 1, and `communal_tables`
  communal tables (`C1`, `C2`, …). Adjacent 2-tops combine in fixed pairs (1/2,
  3/4, …) into a 4-top. Parties of 1–2 take a 2-top, 3–4 a pair, 5 up to
  `max_party` a communal table.
- 2-tops and pairs go to whichever free spot is furthest from anyone already
  seated during that hold, ties broken toward `first_table` — so an empty night
  starts at table 5 and neighbours stay as far apart as the room allows.
- Parties of `large_party_min` or more are shown `large_party_notice` before
  they book and are told we'll reach out to confirm; the booking itself is
  taken like any other.

## Google credentials

Both live on the `dinner` object as `secret` fields, which archival strips from
every template and from the built site — but *not* from this repo, so treat
`objects/dinner.toml` as private.

- `google_service_account` is the whole JSON key of a Google Cloud service
  account with the Sheets API enabled. The spreadsheet must be shared with the
  key's `client_email` as an **Editor**.
- `reservations_sheet_id` is the id from the sheet's URL —
  `https://docs.google.com/spreadsheets/d/<THIS PART>/edit`.

## The spreadsheet

The carrier builds the tabs it needs the first time it sees a spreadsheet
without them, and rebuilds the derived tabs whenever the room's shape in
`dinner.toml` changes. Point it at an empty spreadsheet and it does the rest.

### Tracker

The source of truth. Row 1 is a header; bookings are appended from row 2.

| A | B | C | D | E | F | G | H | I | J | K | L | M |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Date | Name | Time | Party Size | Contact Method | Contact | Notes | Table(s) | Server | Arrived | Status | Newsletter | Booked At |

- **Table(s)** is what the carrier assigned — `5`, `5, 6`, or `C1`. Change it
  to move a party; the Tables and Host Sheet tabs follow.
- **Server** and **Arrived** are for the host to fill in on the night.
- **Status** is `booked` or `cancelled`. Cancelling gives the table back and the
  slot reopens on the form.
- Rows typed in by hand (a phone booking, say) count against availability like
  any other. Fill in at least Date, Time and Party Size; leave Table(s) blank
  and the carrier picks tables for it the next time anyone looks at the form.

### Tables

A floor grid for the date in `B1` (defaults to today): tables down the side,
seatings across the top. Each cell names the party holding that table during
that seating, colored when booked. A combined 4-top fills both of its rows for
the full hold, and a cell with two names (shown red) is a double booking.

### Host Sheet

The night's reservations for the date in `B1`, in seating order: time, name,
table #, party size, server, notes, arrived. It is read-only — a formula over
Tracker — so mark Server and Arrived on the Tracker row and they show up here.

### Config

Hidden. Holds the hold length the Tables formulas use and a fingerprint of the
layout; the carrier owns it.

## Working on it

```sh
npm install
npm run types        # regenerate archival-objects.d.ts after schema edits
npm run typecheck
```

`archival-objects.d.ts` is generated from `archival_objects.toml` and committed —
it holds the schema, never any values.
