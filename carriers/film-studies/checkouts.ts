/**
 * Film Studies checkouts, kept in the site's database: what a screening's
 * guests are counted from, and the record of who bought what. A checkout's
 * status is archival's (`open`, `paid`, `expired`, `canceled`), asked again
 * while it is still open.
 */
import type { CarrierPayments, CarrierSql } from "@archival/carrier";
import { HOLD_MINUTES, type HeldCheckout } from "./order.ts";

/** How often a checkout that is still open past its hold is asked about again. */
export const RECHECK_MINUTES = 5;

const SCHEMA: [string][] = [
  [
    `CREATE TABLE IF NOT EXISTS film_checkouts (
      id TEXT PRIMARY KEY,
      film TEXT NOT NULL,
      guests INTEGER NOT NULL,
      summary TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      checked_at INTEGER NOT NULL
    )`,
  ],
  ["CREATE INDEX IF NOT EXISTS film_checkouts_film ON film_checkouts (film)"],
];

const ready = new WeakMap<CarrierSql, Promise<unknown>>();

const ensureTable = (sql: CarrierSql): Promise<unknown> => {
  let made = ready.get(sql);
  if (!made) {
    made = sql.transaction(SCHEMA).catch((error) => {
      ready.delete(sql);
      throw error;
    });
    ready.set(sql, made);
  }
  return made;
};

export type NewCheckout = {
  id: string;
  /** The film object's path, e.g. "film/footprints". */
  film: string;
  guests: number;
  summary: string;
  name: string;
  email: string;
  phone: string;
};

export const recordCheckout = async (sql: CarrierSql, checkout: NewCheckout, now: number = Date.now()) => {
  await ensureTable(sql);
  await sql.exec(
    `INSERT INTO film_checkouts (id, film, guests, summary, name, email, phone, status, created_at, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?) ON CONFLICT (id) DO NOTHING`,
    checkout.id,
    checkout.film,
    checkout.guests,
    checkout.summary,
    checkout.name,
    checkout.email,
    checkout.phone,
    now,
    now,
  );
};

type Row = { id: string; status: string; guests: number; created_at: number; checked_at: number };

/** Open past its hold, and not asked about in the last RECHECK_MINUTES. */
export const needsRecheck = (row: Row, now: number): boolean =>
  row.status === "open" &&
  now - row.created_at >= HOLD_MINUTES * 60_000 &&
  now - row.checked_at >= RECHECK_MINUTES * 60_000;

/**
 * Every checkout started for `film`, with the open ones past their hold asked
 * about again. Rejects when the database can't be read; a checkout archival
 * can't answer for keeps the status it had.
 */
export const filmCheckouts = async (
  sql: CarrierSql,
  payments: CarrierPayments,
  film: string,
  now: number = Date.now(),
): Promise<HeldCheckout[]> => {
  await ensureTable(sql);
  const rows = await sql.exec<Row>(
    "SELECT id, status, guests, created_at, checked_at FROM film_checkouts WHERE film = ?",
    film,
  );
  const stale = rows.filter((row) => needsRecheck(row, now));
  if (stale.length) {
    const answers = await Promise.all(
      stale.map((row) =>
        payments.checkout.get(row.id).then(
          (checkout) => checkout.status,
          (error) => {
            console.error(`Could not look up Film Studies checkout ${row.id}:`, error);
            return row.status;
          },
        ),
      ),
    );
    stale.forEach((row, index) => {
      row.status = answers[index];
      row.checked_at = now;
    });
    await sql
      .transaction(
        stale.map((row) => [
          "UPDATE film_checkouts SET status = ?, checked_at = ? WHERE id = ?",
          row.status,
          row.checked_at,
          row.id,
        ]),
      )
      .catch((error) => console.error("Could not save Film Studies checkout statuses:", error));
  }
  return rows.map((row) => ({ status: row.status, guests: row.guests, createdAt: row.created_at }));
};
