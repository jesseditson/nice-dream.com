# carriers/pies

Backs the pie pre-order form at `/pie-preorder.html`. Deployed with the site and
reachable at `/carriers/pies`.

| | |
| --- | --- |
| `GET` | whether orders are open, and every pickup time with how many pies it can still take |
| `GET` with `?order=` | the same, plus that order and whether it has been paid |
| `POST` | starts a checkout for an order and logs it to the hidden Checkouts tab |

## Checkout

Checkout goes through archival payments (`site.payments`), in the payment
account connected in the site's settings, so the site needs the Pro plan and a
connected account. Each pie is charged at its variant's price, and the add-on
as one line at `add_on_price`. The guest's email fills in the checkout page,
and the pickup time, their name, phone and notes ride along as the payment's
metadata. The provider sends them back to `/pie-preorder.html?order=<token>`.

The order at the provider carries no pickup time, so the sheet is the record
of when each order is picked up. A guest whose Checkouts row can't be written
is asked to try again rather than sent on to pay. A variant the provider tracks
stock for is refused once it sells out there.

## Content

Everything lives on the `pie_preorder` object (`objects/pie_preorder.toml`;
field notes in `archival_objects.toml`):

- `[[pies]]` — each pie's `variant_id` is the item variation it sells as in the
  connected account, which sets what checkout charges; `price` is only what the
  page shows, so keep the two in step.
- `add_on_*` — one extra (the pint) a pie can carry, at most one per pie,
  charged as its own line at `add_on_price`. A blank `add_on_name` or
  `add_on_price` hides it.
- `[[pickup_windows]]` — pickup times run every `slot_minutes` from `first` to
  `last` on `date`. Any number of orders can choose the same time.
- `orders_close` — local time after which the form shows a closed notice and
  refuses orders.
- `orders_sheet_id` — the id from the orders spreadsheet's URL.

The Google service account is the one already on the `dinner` object. The
spreadsheet must be shared with the service account's `client_email` as an
**Editor**.

## Payment

A checkout started through the form gets a row on the hidden Checkouts tab with
Status `awaiting payment`. Every request asks archival payments about those
rows (each at most every 5 minutes, and the guest's own row whenever they open
their return link) and writes back what it says:

| Checkout | Status |
| --- | --- |
| `paid` | `paid`, with the charged total in Total Paid |
| `open` for more than 30 minutes, or `expired` | `not paid` |
| `canceled` | `cancelled` |

A checkout that turns `paid` gets its row on the Orders tab, so the Orders tab
only ever holds paid orders. `not paid` rows are checked again for two days in
case the guest comes back to the link. Orders are matched to rows by the
Checkout ID column, so mark an unwanted row `cancelled` rather than deleting
it.

## The spreadsheet

The carrier builds its tabs on an empty spreadsheet, and rewrites the Orders
header and the Bake List whenever the pies, add-on or pickup days change.

- **Orders** — one row per paid order. Pickup Time is a clock time such as
  `2:00 PM`; rows added from the old Square dashboard link say `unscheduled`.
  The per-pie count columns follow the fixed ones in menu order, then the
  add-on. They're found by position, so add new pies to the end of `[[pies]]`
  rather than reordering them. Picked Up is a checkbox for the day.
- **Bake List** — how many of each pie, and how many orders, each pickup day,
  counting every order except `not paid` and `cancelled` ones.
- **Checkouts** — hidden; one row per checkout started through the form, with
  the same columns as Orders, whether or not it was paid.
- **Config** — hidden; a fingerprint of the layout.

## Working on it

```sh
npm install
npm run types        # regenerate archival-objects.d.ts after schema edits
npm run typecheck
npm test
```
