/**
 * The orders spreadsheet: an Orders tab with one row per checkout started, a
 * Bake List that totals the pies due on each pickup day, and a hidden Config
 * tab. The carrier builds them on an empty spreadsheet and rebuilds the header
 * and Bake List whenever the menu or pickup days change.
 */
import type { SheetsClient } from "./google.ts";
import { type Menu, type Selection, isIsoDate, parseHHMM, parseLocalTimestamp } from "./menu.ts";
import type { OrderState } from "./square.ts";

export const ORDERS = "Orders";
export const BAKE = "Bake List";
export const CONFIG = "Config";

const SETUP_VERSION = 1;

/** Orders columns before the per-pie counts, which follow in menu order and end with the add-on. */
export const FIXED_COLUMNS = [
  "Pickup Date",
  "Pickup Time",
  "Name",
  "Status",
  "Picked Up",
  "Order",
  "Phone",
  "Email",
  "Notes",
  "Total Paid",
  "Ordered At",
  "Square Order",
  "Checkout Link",
  "Token",
];

export const COL = {
  date: 0,
  time: 1,
  name: 2,
  status: 3,
  pickedUp: 4,
  summary: 5,
  phone: 6,
  email: 7,
  notes: 8,
  total: 9,
  orderedAt: 10,
  squareOrder: 11,
  checkout: 12,
  token: 13,
  counts: 14,
} as const;

export const STATUS = {
  awaiting: "awaiting payment",
  notPaid: "not paid",
  paid: "paid",
  cancelled: "cancelled",
} as const;

/** How long a checkout can go unpaid before its row says so. */
export const UNPAID_AFTER_MINUTES = 30;
/** Unpaid checkouts older than this are no longer looked up in Square, except by their own guest. */
const SYNC_DAYS = 2;

export const headers = (menu: Menu): string[] => [
  ...FIXED_COLUMNS,
  ...menu.pies.map((pie) => pie.name),
  ...(menu.addOn ? [menu.addOn.name] : []),
];

export const columnLetter = (index: number): string => {
  let letters = "";
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
  }
  return letters;
};

const range = (tab: string, cells: string): string => encodeURIComponent(`${tab}!${cells}`);

type Cell = string | number | boolean | undefined;

const SHEETS_EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

const dateSerial = (date: string): number => {
  const [year, month, day] = date.split("-").map(Number);
  return (Date.UTC(year, month - 1, day) - SHEETS_EPOCH) / DAY_MS;
};

const cellDate = (cell: Cell): string | null => {
  if (typeof cell === "number") {
    return new Date(SHEETS_EPOCH + Math.floor(cell) * DAY_MS).toISOString().slice(0, 10);
  }
  if (typeof cell !== "string") return null;
  const value = cell.trim();
  if (isIsoDate(value)) return value;
  const us = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return us ? `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}` : null;
};

const cellTime = (cell: Cell): number | null => {
  if (typeof cell === "number") return Math.round((cell - Math.floor(cell)) * 1440);
  return typeof cell === "string" ? parseHHMM(cell) : null;
};

const cellText = (cell: Cell): string => (cell == null ? "" : String(cell).trim());

export type OrderRow = {
  row: number;
  date: string | null;
  start: number | null;
  name: string;
  status: string;
  summary: string;
  orderedAt: string;
  squareOrder: string;
  checkout: string;
  token: string;
};

export const readOrders = async (client: SheetsClient, menu: Menu): Promise<OrderRow[]> => {
  const last = columnLetter(headers(menu).length - 1);
  const response = await client<{ values?: Cell[][] }>(
    "GET",
    `/values/${range(ORDERS, `A2:${last}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`,
  );
  return (response.values ?? []).map((cells, index) => ({
    row: index + 2,
    date: cellDate(cells[COL.date]),
    start: cellTime(cells[COL.time]),
    name: cellText(cells[COL.name]),
    status: cellText(cells[COL.status]).toLowerCase(),
    summary: cellText(cells[COL.summary]),
    orderedAt: cellText(cells[COL.orderedAt]),
    squareOrder: cellText(cells[COL.squareOrder]),
    checkout: cellText(cells[COL.checkout]),
    token: cellText(cells[COL.token]),
  }));
};

/** The status Square says a row should have, or null to leave it. */
export const statusFrom = (current: string, square: OrderState, now: Date = new Date()): string | null => {
  let next: string;
  if (square.state === "CANCELED") next = STATUS.cancelled;
  else if (square.state === "OPEN" || square.state === "COMPLETED") next = STATUS.paid;
  else if (square.state === "DRAFT") {
    const age = square.createdAt ? now.getTime() - square.createdAt.getTime() : 0;
    next = age > UNPAID_AFTER_MINUTES * 60_000 ? STATUS.notPaid : STATUS.awaiting;
  } else return null;
  return next === current ? null : next;
};

/** Rows whose payment is still unknown, plus `token`'s row however old it is. */
export const rowsToSync = (orders: OrderRow[], token: string, now: Date = new Date()): OrderRow[] =>
  orders.filter((order) => {
    if (!order.squareOrder) return false;
    if (token && order.token === token) return true;
    if (order.status === STATUS.awaiting) return true;
    if (order.status !== STATUS.notPaid) return false;
    const ordered = parseLocalTimestamp(order.orderedAt);
    return ordered != null && now.getTime() - ordered.getTime() < SYNC_DAYS * DAY_MS;
  });

export const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

/** Writes what Square says back to the rows, and updates `orders` to match. */
export const applyStates = async (
  client: SheetsClient,
  orders: OrderRow[],
  states: Map<string, OrderState>,
  now: Date = new Date(),
): Promise<void> => {
  const data: { range: string; values: Cell[][] }[] = [];
  for (const order of orders) {
    const square = states.get(order.squareOrder);
    if (!square) continue;
    const next = statusFrom(order.status, square, now);
    if (!next) continue;
    order.status = next;
    data.push({ range: `${ORDERS}!${columnLetter(COL.status)}${order.row}`, values: [[next]] });
    if (next === STATUS.paid && square.total != null) {
      data.push({ range: `${ORDERS}!${columnLetter(COL.total)}${order.row}`, values: [[dollars(square.total)]] });
    }
  }
  if (!data.length) return;
  try {
    await client("POST", "/values:batchUpdate", { valueInputOption: "RAW", data });
  } catch (error) {
    console.error("Could not write payment states to the Orders tab:", error);
  }
};

/** Pickup Time on a row whose order was placed without choosing one. */
export const ANY_TIME = "any time";

export type NewOrder = {
  date: string;
  /** null for an order placed without choosing a time. */
  start: number | null;
  status: string;
  total: string;
  name: string;
  phone: string;
  email: string;
  notes: string;
  summary: string;
  selection: Selection;
  orderedAt: string;
  squareOrder: string;
  checkout: string;
  token: string;
};

const orderRow = (menu: Menu, order: NewOrder): Cell[] => {
  const row: Cell[] = [];
  row[COL.date] = dateSerial(order.date);
  row[COL.time] = order.start == null ? ANY_TIME : order.start / 1440;
  row[COL.name] = order.name;
  row[COL.status] = order.status;
  row[COL.pickedUp] = false;
  row[COL.summary] = order.summary;
  row[COL.phone] = order.phone;
  row[COL.email] = order.email;
  row[COL.notes] = order.notes;
  row[COL.total] = order.total;
  row[COL.orderedAt] = order.orderedAt;
  row[COL.squareOrder] = order.squareOrder;
  row[COL.checkout] = order.checkout;
  row[COL.token] = order.token;
  menu.pies.forEach((pie, offset) => {
    row[COL.counts + offset] = order.selection.pies.get(pie.id) ?? 0;
  });
  if (menu.addOn) row[COL.counts + menu.pies.length] = order.selection.addOns;
  return row;
};

export const appendOrders = async (client: SheetsClient, menu: Menu, orders: NewOrder[]): Promise<void> => {
  if (!orders.length) return;
  const header = `A1:${columnLetter(headers(menu).length - 1)}1`;
  // Anchoring on the header keeps new rows directly under the orders even when something sits far below them.
  await client(
    "POST",
    `/values/${range(ORDERS, header)}:append?valueInputOption=RAW&insertDataOption=OVERWRITE`,
    { range: `${ORDERS}!${header}`, majorDimension: "ROWS", values: orders.map((order) => orderRow(menu, order)) },
  );
};

// ---- building the spreadsheet ------------------------------------------------

type SheetInfo = { properties: { sheetId: number; title: string } };
type Request = Record<string, unknown>;

const layoutKey = (menu: Menu): string =>
  [
    `v${SETUP_VERSION}`,
    headers(menu).join("|"),
    [...new Set(menu.windows.map((window) => window.date))].join(","),
  ].join(" ");

let verifiedLayout: string | null = null;

export const ensureSheet = async (client: SheetsClient, menu: Menu): Promise<void> => {
  const wanted = layoutKey(menu);
  if (verifiedLayout === wanted) return;
  let current = "";
  try {
    const response = await client<{ values?: string[][] }>("GET", `/values/${range(CONFIG, "B1")}`);
    current = String(response.values?.[0]?.[0] ?? "");
  } catch {
    // No Config tab yet: a fresh spreadsheet.
  }
  if (current !== wanted) await buildSheet(client, menu, wanted);
  verifiedLayout = wanted;
};

const listSheets = async (client: SheetsClient): Promise<SheetInfo[]> =>
  (await client<{ sheets: SheetInfo[] }>("GET", "?fields=sheets(properties(sheetId,title))")).sheets;

const columnRange = (sheetId: number, column: number, fromRow = 1): Request => ({
  sheetId,
  startRowIndex: fromRow,
  startColumnIndex: column,
  endColumnIndex: column + 1,
});

const formatCells = (gridRange: Request, format: Record<string, unknown>): Request => ({
  repeatCell: {
    range: gridRange,
    cell: { userEnteredFormat: format },
    fields: Object.keys(format)
      .map((key) => `userEnteredFormat.${key}`)
      .join(","),
  },
});

/** One row per pickup day and a total, counting every order that still holds its pies. */
const bakeList = (menu: Menu): Cell[][] => {
  const counted = headers(menu).slice(COL.counts);
  const orders = (column: number) => `${ORDERS}!$${columnLetter(column)}$2:$${columnLetter(column)}`;
  const released = `${orders(COL.status)},"<>${STATUS.notPaid}",${orders(COL.status)},"<>${STATUS.cancelled}"`;
  const dayRow = (date: string, row: number): Cell[] => [
    `=DATEVALUE("${date}")`,
    ...counted.map((_, offset) => `=SUMIFS(${orders(COL.counts + offset)},${orders(COL.date)},$A${row},${released})`),
    `=COUNTIFS(${orders(COL.date)},$A${row},${released})`,
  ];
  const dates = [...new Set(menu.windows.map((window) => window.date))];
  const totalRow = dates.length + 2;
  return [
    ["Pickup Date", ...counted, "Orders"],
    ...dates.map((date, index) => dayRow(date, index + 2)),
    [
      "All days",
      ...counted.map((_, offset) => `=SUM(${columnLetter(offset + 1)}2:${columnLetter(offset + 1)}${totalRow - 1})`),
      `=SUM(${columnLetter(counted.length + 1)}2:${columnLetter(counted.length + 1)}${totalRow - 1})`,
    ],
    [],
    [`Counts every order except those marked "${STATUS.notPaid}" or "${STATUS.cancelled}".`],
  ];
};

const buildSheet = async (client: SheetsClient, menu: Menu, layout: string): Promise<void> => {
  let sheets = await listSheets(client);
  const has = (title: string) => sheets.some((sheet) => sheet.properties.title === title);
  const firstBuild = !has(ORDERS);
  const missing = [ORDERS, BAKE, CONFIG].filter((title) => !has(title));
  if (missing.length) {
    await client("POST", ":batchUpdate", {
      requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
    });
    sheets = await listSheets(client);
  }
  const sheetId = (title: string): number => {
    const found = sheets.find((entry) => entry.properties.title === title);
    if (!found) throw new Error(`Could not create the "${title}" tab.`);
    return found.properties.sheetId;
  };
  const ordersId = sheetId(ORDERS);
  const bakeId = sheetId(BAKE);
  const configId = sheetId(CONFIG);

  await client("POST", `/values/${range(BAKE, "A1:Z100")}:clear`, {});
  await client("POST", "/values:batchUpdate", {
    valueInputOption: "USER_ENTERED",
    data: [
      { range: `${ORDERS}!A1`, values: [headers(menu)] },
      { range: `${BAKE}!A1`, values: bakeList(menu) },
      { range: `${CONFIG}!A1`, values: [["Layout", layout]] },
    ],
  });

  const requests: Request[] = [
    {
      updateSheetProperties: {
        properties: { sheetId: ordersId, gridProperties: { frozenRowCount: 1 } },
        fields: "gridProperties.frozenRowCount",
      },
    },
    formatCells({ sheetId: ordersId, startRowIndex: 0, endRowIndex: 1 }, { textFormat: { bold: true } }),
    formatCells(columnRange(ordersId, COL.date), { numberFormat: { type: "DATE", pattern: "ddd, mmm d" } }),
    formatCells(columnRange(ordersId, COL.time), { numberFormat: { type: "TIME", pattern: "h:mm am/pm" } }),
    {
      setDataValidation: {
        range: columnRange(ordersId, COL.pickedUp),
        rule: { condition: { type: "BOOLEAN" } },
      },
    },
    {
      setDataValidation: {
        range: columnRange(ordersId, COL.status),
        rule: {
          condition: {
            type: "ONE_OF_LIST",
            values: Object.values(STATUS).map((userEnteredValue) => ({ userEnteredValue })),
          },
          showCustomUi: true,
          strict: false,
        },
      },
    },
    {
      updateSheetProperties: {
        properties: { sheetId: bakeId, gridProperties: { frozenRowCount: 1 } },
        fields: "gridProperties.frozenRowCount",
      },
    },
    formatCells({ sheetId: bakeId, startRowIndex: 0, endRowIndex: 1 }, { textFormat: { bold: true } }),
    formatCells(columnRange(bakeId, 0), { numberFormat: { type: "DATE", pattern: "dddd, mmmm d" } }),
    { updateSheetProperties: { properties: { sheetId: configId, hidden: true }, fields: "hidden" } },
  ];

  // A brand-new spreadsheet comes with an empty "Sheet1" nobody needs.
  const starter = sheets.find((entry) => entry.properties.title === "Sheet1");
  if (firstBuild && starter) requests.push({ deleteSheet: { sheetId: starter.properties.sheetId } });

  await client("POST", ":batchUpdate", { requests });
};
