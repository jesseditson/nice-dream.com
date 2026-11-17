# carriers/film-studies

Backs the ticket form on `/film-studies` and each `/film/<name>` page.
Deployed with the site and reachable at `/carriers/film-studies`.

| | |
| --- | --- |
| `GET ?film=` | whether the film is on sale and `spots_left` (null without a limit, or when Square can't be reached) |
| `POST` | `{ film, tickets: { <index>: quantity }, donation, name, email, phone }` → starts a Square checkout and answers with its URL |

The order is created through Square's Checkout API with the tickets, the
donation, and a `SCHEDULED` pickup at the screening's start carrying the
guest's name, email and phone, so it shows on Square's order list that night.
The guest pays on Square's checkout page (tipping is offered when the order has
tickets) and Square sends them back to the film's page with `?paid=`, where the
form shows a confirmation. There's no spreadsheet: Square is the record.

Online sales close when the film's `starts` passes; the page hides the form at
the same moment.

Each ticket is one guest. Before a checkout starts, the carrier searches
Square's pickup orders for the screening (matched by pickup time and ticket
name or variation) and counts paid orders plus checkouts started in the last 20
minutes against `max_guests`. An order that would go over it is refused with the
spots left, and the page hides the tickets once the screening is full; donations
stay open. A checkout abandoned for longer than that and paid later can still
push a screening slightly over.

## Content

- `objects/film/<name>.toml` — one film per screening; the latest by `starts`
  is the one `/film-studies` shows.
- `objects/film/<name>.toml` `[[scene]]` — stills shown full screen behind the
  page, in order, drawn by `src/film-scenes.ts`.
- `objects/film_studies.toml` — the tickets, the donation row, the About text,
  `max_guests` and `square_location_id`.
  - `[[ticket]]` — sold once it has a `name` and a `price`. With
    `square_variation_id` set, Square charges that catalog variation's price
    and tax, so keep `price` in step; blank sends a plain, untaxed line item at
    `price`. Tickets are matched by position, so add new ones to the end.
  - `donation_variation_id` — a variable-price Square item with no tax; blank
    sends a plain "Donation to Film Studies" line item.

The Square access token is the one on the `dinner` object; it needs
`ORDERS_WRITE` and `PAYMENTS_WRITE` (and `ITEMS_READ` once catalog variations
are set), which the pie carrier already relies on.

## Working on it

```sh
npm install
npm run types        # regenerate archival-objects.d.ts after schema edits
npm run typecheck
npm test
```
