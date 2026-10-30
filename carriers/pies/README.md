# carriers/pies

Backs the pie pre-order form at `/pie-preorder.html`. Deployed with the site and
reachable at `/carriers/pies`.

| | |
| --- | --- |
| `GET` | whether orders are open, and every pickup time with how many pies it can still take |
| `GET` with `?order=` | the same, plus that order and whether it has been paid |
| `POST` | starts a Square checkout for an order and logs it to the sheet |

## Why not just the Square link

A Square checkout link created in the dashboard has no way to choose a pickup
time. It schedules every order as ASAP, for the next time the location is open,
so a pie ordered on November 2nd shows up in Square as due on November 2nd.

Instead, the form collects the pies and a pickup time, and the carrier creates
a payment link for that one order through Square's Checkout API. The link's
order already carries the line items, a `SCHEDULED` pickup fulfillment at the
chosen time, and the guest's name, email and phone. The guest pays on
Square's own checkout page, with tipping on as before, and Square sends
them back to `/pie-preorder.html?order=<token>`.

The order in Square is complete on its own. The sheet is a working copy for
the kitchen.

## Orders through the Square link

The dashboard link still works. Every request searches Square for paid pickup
orders from the last 60 days that include a pie on the menu, and for each one:

- If it isn't on the sheet, it gets a row: Status `paid`, Pickup Date the first
  pickup day, and Pickup Time `any time`, since the guest never chose one. An
  order already scheduled for a pickup day keeps its own date and time.
- If its pickup isn't scheduled on a pickup day (the link's orders are always
  ASAP), it's moved in Square to the first pickup time, so Square's order list
  and tickets show the right day. A move that fails is logged and tried again
  on the next request.

Orders are matched to rows by the Square Order column, so mark an unwanted row
`cancelled` rather than deleting it, or the next request adds it back. The
search also catches a form order whose row failed to write, once it's paid.

Nothing runs in the background, so a link order reaches the sheet the next
time anyone loads the form.

## Content

Everything lives on the `pie_preorder` object (`objects/pie_preorder.toml`;
field notes in `archival_objects.toml`):

- `[[pies]]` — each pie's `square_variation_id` is the Square catalog item
  variation it sells as. Square charges its catalog price; `price` is only what
  the page shows, so keep the two in step.
- `add_on_*` — one extra (the pint) sold as a Square modifier on a pie, at most
  one per pie. A blank `add_on_name` hides it.
- `[[pickup_windows]]` — pickup times run every `slot_minutes` from `first` to
  `last` on `date`. `pies_per_slot` caps how many pies one time takes; 0 means
  no cap.
- `orders_close` — local time after which the form shows a closed notice and
  refuses orders.
- `square_location_id` — the location orders are placed at.
- `orders_sheet_id` — a `secret`: the id from the orders spreadsheet's URL.

The Google service account and the Square access token are the ones already on
the `dinner` object. The spreadsheet must be shared with the service account's
`client_email` as an **Editor**, and the Square token needs `ORDERS_READ`,
`ORDERS_WRITE`, `PAYMENTS_WRITE` and `ITEMS_READ`.

## Payment

A new row's Status is `awaiting payment`. Every request asks Square about those
rows and writes back what it says:

| Square order | Status |
| --- | --- |
| `OPEN` or `COMPLETED` | `paid`, with the charged total in Total Paid |
| `DRAFT` for more than 30 minutes | `not paid` |
| `CANCELED` | `cancelled` |

`not paid` rows are checked again for two days in case the guest comes back to
the link, and the guest's own row is checked whenever they open their return
link.

A pickup time's cap counts every row except `not paid` and `cancelled` ones, so
an unpaid checkout holds its pies for 30 minutes and then lets them go. Rows
typed in by hand, with no status, count too.

If the row can't be written, the guest still goes to checkout. Once they pay,
the search for [link orders](#orders-through-the-square-link) adds the row.

## The spreadsheet

The carrier builds its tabs on an empty spreadsheet, and rewrites the Orders
header and the Bake List whenever the pies, add-on or pickup days change.

- **Orders** — one row per checkout started. The per-pie count columns follow
  the fixed ones in menu order, then the add-on. They're found by position, so
  add new pies to the end of `[[pies]]` rather than reordering them. Picked Up
  is a checkbox for the day.
- **Bake List** — how many of each pie, and how many orders, each pickup day,
  counting every order except `not paid` and `cancelled` ones.
- **Config** — hidden; a fingerprint of the layout.

## Working on it

```sh
npm install
npm run types        # regenerate archival-objects.d.ts after schema edits
npm run typecheck
npm test
```
