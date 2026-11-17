# carriers/film-studies

Backs the ticket form on `/film-studies` and each `/film/<name>` page.
Deployed with the site and reachable at `/carriers/film-studies`.

| | |
| --- | --- |
| `GET ?film=` | whether the film is on sale and `spots_left` (null without a limit, or when the database can't be read) |
| `POST` | `{ film, tickets: { <index>: quantity }, donation, name, email, phone }` → starts a checkout and answers with its URL |

Checkout goes through archival payments (`site.payments`), in the payment
account connected in the site's settings, so the site needs the Pro plan and a
connected account. Tickets with a `variant_id` are charged at that variation's
price; the rest, and the tip (the `donation` field, sold as "Tip Your
Professor"), are charged as lines priced here. The guest's email fills in the
checkout page, and the film, their name, phone and order ride along as the
payment's metadata. The provider sends them back to the
film's page with `?paid=`, where the form shows a confirmation.

Every checkout is kept in the site's database (`site.sql`, table
`film_checkouts`) with the guest's name, email, phone and order, which is the
guest list for the night.

Online sales close when the film's `starts` passes; the page hides the form at
the same moment.

Each ticket is one guest. Before a checkout starts, the carrier counts the
film's paid checkouts plus those started in the last 20 minutes against
`max_guests`. A checkout still open after that is asked about again at most
every 5 minutes, so one paid late still counts. An order that would go over the
limit is refused with the spots left, and the page hides the tickets once the
screening is full; tips stay open. A variation the provider tracks stock
for is also refused once it sells out there.

`site.sql` isn't available in the editor's preview or under `archival run`, so
there `spots_left` is null and an order with tickets is refused while
`max_guests` is set.

## Content

- `objects/film/<name>.toml` — one film per screening; the latest by `starts`
  is the one `/film-studies` shows.
- `objects/film/<name>.toml` `[[scene]]` — stills shown full screen behind the
  page, in order, drawn by `src/film-scenes.ts`.
- `objects/film_studies.toml` — the tickets, the tip row (`donation_*`), the
  About and About Your Host text, and `max_guests`.
  - `[[ticket]]` — sold once it has a `name` and a `price`. `variant_id` is an
    item variation in the connected account; keep `price` in step with it.
    Blank charges a plain line at `price`. Tickets are matched by position, so
    add new ones to the end.

## Working on it

```sh
npm install
npm run types        # regenerate archival-objects.d.ts after schema edits
npm run typecheck
npm test
```
