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
  "bar_seats": 4,
  "dates": [
    {
      "date": "2026-10-02",
      "label": "Friday, October 2nd",
      "slots": [
        { "time": "17:30", "label": "5:30 PM", "two": true, "four": false, "communal": true, "bar": 2 }
      ]
    }
  ]
}
```

`two`, `four` and `communal` say whether that seating can still take a
dining-room party of 1–2, of 3–4, or of 5 and up. `bar` is the largest party
the bar can still seat together. Between them the form answers every party
size, in either area, from one request. [Table assignment](#table-assignment)
explains how each is decided.

A `POST` body is `{ party_size, date, time, name, contact_method, email?,
phone?, notes?, newsletter?, area? }` — `time` as `HH:MM`, `contact_method` as
`email` or `sms` with the matching `email`/`phone` filled in, and `area` as
`dining` (the default) or `bar`. Anything the guest can fix
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
- The dining room is `two_tops` 2-tops, `four_tops` 4-tops and
  `communal_tables` communal tables, and takes parties up to `max_party`. The
  bar is `bar_seats` seats, booked only by guests who choose it. Which table or
  seats a party gets is covered under [Table assignment](#table-assignment).
- Parties of `large_party_min` or more are shown `large_party_notice` before
  they book and are told we'll reach out to confirm; the booking itself is
  taken like any other.

## Table assignment

The carrier picks a party's table at the moment it takes the booking and writes
it to the Tracker's Table(s) column. It never moves a booking afterwards; to
reseat a party, edit that cell.

The same logic decides what the form shows as open (a seating is open for a
party size when the carrier could seat that party) and fills in Table(s) for
rows staff type into the Tracker without one.

### The room

| Tables | Named | Set by |
| --- | --- | --- |
| 2-tops | `1`–`10` | `two_tops` |
| 4-tops | `13`, `14` | `four_tops`, numbered up from `four_top_start` |
| Communal | `C1`, `C2` | `communal_tables` |
| Bar seats | `B1`–`B4` | `bar_seats` |

`four_tops` is 0 until the tables exist. Set it to 2 and tables 13 and 14 start
taking bookings and get their own rows on the Tables tab.

Two 2-tops can be pushed together to seat four, but only in the fixed pairs
1/2, 3/4, 5/6, 7/8 and 9/10 — never 2/3 or 4/5.

The dining room and the bar are separate areas. The guest picks one on the
form, and a full area never borrows from the other: a dining-room party is
turned away when the tables are gone even if the bar is empty, and the reverse.

### What a party gets in the dining room

| Party | Gets |
| --- | --- |
| 1–2 | one 2-top |
| 3–4 | a 4-top if one is free (`13` before `14`), otherwise a pair of 2-tops |
| 5 up to `max_party` | a communal table (`C1` before `C2`) |
| more than `max_party` | refused, and asked to email |

A party is never seated at a larger kind of table than this: two people don't
get a 4-top or a communal table, even when every 2-top is taken.

### What a party gets at the bar

Each guest takes one seat, and a party sits on adjacent seats, so the bar takes
parties of 1 up to `bar_seats`. The form's bar option is hidden while
`bar_seats` is 0.

1. Find every unbroken stretch of free seats.
2. Take the shortest stretch the party fits in, so a longer one stays whole for
   a bigger party. If two are the same length, take the one with the lower
   seat numbers.
3. Seat the party from the low end of that stretch.

On an empty bar, two parties of two get B1/B2 and then B3/B4. With only B2
taken, a solo guest gets B1 rather than breaking up B3/B4, and a party of three
is turned away because no three free seats are side by side.

Bar seats are held and released the same way as tables, described next.

Rows staff type into the Tracker without a table are always given dining-room
tables. To put one at the bar, type the seats (`B1, B2`) into Table(s).

### When a table is free

A booking holds its tables for `hold_minutes` from its seating time. A table is
free for a new party only if nothing already booked on it overlaps the new
party's own hold. With 90-minute holds and seatings every 30 minutes, a 6:30
booking blocks its table for the 5:30, 6:00, 6:30, 7:00 and 7:30 seatings and
leaves it free at 8:00.

Rows whose Status is `cancelled` hold nothing.

### Spacing

2-tops and pairs are chosen to keep parties as far apart as the night allows:

1. Start from every free 2-top — or, for a party of 3–4, every pair with both
   tables free.
2. For each, find the distance to the nearest 2-top that is taken. Distance is
   the difference between table numbers, so table 3 is two away from table 5. A
   pair is measured from whichever of its two tables is closer.
3. Take the one with the largest distance.
4. On a tie, take the one closest to `first_table`. If that ties too, take the
   lowest table number.

With nothing seated, every table ties at step 3, so the first booking of the
night goes to `first_table` — table 5, or the pair 5/6.

"Taken" means held at any point during the new party's hold, not only at the
same seating time: a 7:00 party of two arriving after a 6:30 party on table 5
is seated at table 10. Only 2-tops count as neighbours. A seated 4-top,
communal table or bar seat doesn't push anyone away, because their numbers
aren't positions in the row of 2-tops.

On an empty night, parties booking the same seating fill the room in this
order:

| Parties of | Order |
| --- | --- |
| 1–2 | 5, 10, 1, 3, 7, 4, 6, 2, 8, 9 |
| 3–4, no 4-tops | 5/6, 1/2, 9/10, 3/4, 7/8 |
| 3–4, with 4-tops | 13, 14, 5/6, 1/2, 9/10, 3/4, 7/8 |
| 5 and up | C1, C2 |

### What spacing costs

Spreading 2-tops out breaks up the pairs. Five parties of two at one seating
take tables 5, 10, 1, 3 and 7, which leaves one table in use in every pair. A
party of 3–4 is then turned away for that seating and the ones that overlap it,
even though five 2-tops are empty. Once the room has 4-tops, those parties go
to 13 and 14 first and this matters less.

## Google credentials

Both live on the `dinner` object as `secret` fields, which archival strips from
every template and from the built site — but *not* from this repo, so treat
`objects/dinner.toml` as private.

- `google_service_account` is the whole JSON key of a Google Cloud service
  account with the Sheets API enabled. The spreadsheet must be shared with the
  key's `client_email` as an **Editor**.
- `reservations_sheet_id` is the id from the sheet's URL —
  `https://docs.google.com/spreadsheets/d/<THIS PART>/edit`.

## Booking emails

Every booking the form takes is emailed to each `email` in the dinner object's
`[[reservation_emails]]` list, from `reservation@nice-dream.com`. The email gives the
guest's name, the date and time, the party size, the table or bar seats, how to
reach them, any notes, whether they signed up for the newsletter, and a link to the
Tracker. Large parties are flagged, because the form told them we'd reach out.
When the guest left an email, replying goes straight to them.

Sending uses archival's `objects.EMAIL`, so the site's plan has to include email,
and `reservation@nice-dream.com` has to exist in the site's email settings. The
booking is on the sheet before the email goes out, so a failed send never turns
a guest away. It is logged instead, and archival emails the site's owner if
delivery fails later. Rows typed into the Tracker by hand aren't emailed.

## The spreadsheet

The carrier builds the tabs it needs the first time it sees a spreadsheet
without them, and rebuilds the derived tabs whenever the room's shape in
`dinner.toml` changes. Point it at an empty spreadsheet and it does the rest.

### Tracker

The source of truth. Row 1 is a header; bookings are appended from row 2.

| A | B | C | D | E | F | G | H | I | J | K | L | M |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Date | Name | Time | Party Size | Contact Method | Contact | Notes | Table(s) | Server | Arrived | Status | Newsletter | Booked At |

- **Table(s)** is what the carrier assigned — `5`, `5, 6`, `13`, `C1`, or `B1, B2`. Change it
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
npm test
```

`archival-objects.d.ts` is generated from `archival_objects.toml` and committed —
it holds the schema, never any values.

`npm test` runs the `*.test.ts` files with Node's built-in test runner, which
executes the TypeScript directly and so needs Node 22.18 or newer. `room.test.ts`
covers everything under [Table assignment](#table-assignment) — what each party
size gets, how long a table is held, the spacing order, 4-tops, and the
open/closed flags the form reads — against a room defined in the test file.
`notify.test.ts` covers the [booking email](#booking-emails) against a stand-in
for `objects.EMAIL`. Neither depends on `objects/dinner.toml`, touches the
spreadsheet, or sends mail.
