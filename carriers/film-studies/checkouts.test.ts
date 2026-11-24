import assert from "node:assert/strict";
import { test } from "node:test";
import type { CarrierCheckout, CarrierPayments, CarrierSql, CarrierSqlParam } from "@archival/carrier";
import { RECHECK_MINUTES, filmCheckouts, recordCheckout } from "./checkouts.ts";
import { HOLD_MINUTES } from "./order.ts";

type Row = {
  id: string;
  film: string;
  guests: number;
  status: string;
  created_at: number;
  checked_at: number;
};

/** Just enough of SQLite for the statements checkouts.ts sends. */
const fakeSql = () => {
  const rows: Row[] = [];
  const run = (sql: string, params: CarrierSqlParam[]) => {
    if (sql.startsWith("CREATE")) return [];
    if (sql.startsWith("INSERT")) {
      const [id, film, guests, , , , , created, checked] = params as [string, string, number, ...unknown[]];
      if (!rows.some((row) => row.id === id)) {
        rows.push({ id, film, guests, status: "open", created_at: created as number, checked_at: checked as number });
      }
      return [];
    }
    if (sql.startsWith("SELECT")) return rows.filter((row) => row.film === params[0]).map((row) => ({ ...row }));
    if (sql.startsWith("UPDATE")) {
      const [status, checked, id] = params as [string, number, string];
      const row = rows.find((entry) => entry.id === id);
      if (row) Object.assign(row, { status, checked_at: checked });
      return [];
    }
    throw new Error(`unexpected statement: ${sql}`);
  };
  const sql = {
    exec: async (statement: string, ...params: CarrierSqlParam[]) => run(statement, params),
    transaction: async (statements: [string, ...CarrierSqlParam[]][]) =>
      statements.map(([statement, ...params]) => run(statement, params)),
  } as unknown as CarrierSql;
  return { sql, rows };
};

const fakePayments = (statuses: Record<string, CarrierCheckout["status"]>) => {
  const asked: string[] = [];
  const payments = {
    checkout: {
      get: async (id: string): Promise<CarrierCheckout> => {
        asked.push(id);
        if (!statuses[id]) throw new Error("That is not a checkout this site made");
        return { id, status: statuses[id], amountTotal: null, currency: null, customerEmail: null };
      },
    },
  } as unknown as CarrierPayments;
  return { payments, asked };
};

const guest = { summary: "1 Admission", name: "Ada", email: "ada@example.com", phone: "+17605550100" };
const minutes = (count: number) => count * 60_000;

test("open checkouts past their hold are asked about again, at most every few minutes", async () => {
  const { sql, rows } = fakeSql();
  const start = Date.parse("2026-11-20T20:00:00Z");
  await recordCheckout(sql, { ...guest, id: "fresh", film: "film/a", guests: 2 }, start + minutes(30));
  await recordCheckout(sql, { ...guest, id: "late", film: "film/a", guests: 3 }, start);
  await recordCheckout(sql, { ...guest, id: "gone", film: "film/a", guests: 4 }, start);
  await recordCheckout(sql, { ...guest, id: "other", film: "film/b", guests: 5 }, start);
  await recordCheckout(sql, { ...guest, id: "late", film: "film/a", guests: 9 }, start);

  const { payments, asked } = fakePayments({ late: "paid", fresh: "open" });
  const now = start + minutes(HOLD_MINUTES + 15);
  const held = await filmCheckouts(sql, payments, "film/a", now);
  assert.deepEqual(asked.sort(), ["gone", "late"]);
  assert.deepEqual(
    held.map((checkout) => [checkout.status, checkout.guests]),
    [
      ["open", 2],
      ["paid", 3],
      ["open", 4],
    ],
  );
  assert.equal(rows.find((row) => row.id === "late")?.status, "paid");
  assert.equal(rows.find((row) => row.id === "gone")?.checked_at, now);

  asked.length = 0;
  await filmCheckouts(sql, payments, "film/a", now + minutes(RECHECK_MINUTES - 1));
  assert.deepEqual(asked, []);
  await filmCheckouts(sql, payments, "film/a", now + minutes(RECHECK_MINUTES));
  assert.deepEqual(asked, ["gone"]);
});
