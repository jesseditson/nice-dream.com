/**
 * Reading and writing the Tracker tab. Bookings are appended, and a guest's
 * edits change the row in place with a note of what changed written to the
 * right of it; a table is given back by setting Status, and the Tables and
 * Host Sheet tabs derive from here by formula (see setup.ts).
 */
import type { SheetsClient } from "./google";
import {
  type Booking,
  type OpenTicket,
  type Rules,
  assignTables,
  holdFor,
  isIsoDate,
  occupiedAt,
  parseHHMM,
  reconcileWalkIns,
  seatingFor,
  timestampIn,
  turningAt,
} from "./room.ts";

export const TRACKER = "Tracker";
export const TABLES = "Tables";
export const HOST = "Host Sheet";
export const CONFIG = "Config";

/** Tracker columns in order. Row 1 is this header; bookings start on row 2. */
export const TRACKER_COLUMNS = [
  "Date",
  "Name",
  "Time",
  "Party Size",
  "Notes",
  "Table(s)",
  "Contact Method",
  "Server",
  "Contact",
  "Arrived",
  "Status",
  "Newsletter",
  "Booked At",
  "Token",
  "Edits",
];

export const COL = {
  date: 0,
  name: 1,
  time: 2,
  party: 3,
  notes: 4,
  tables: 5,
  method: 6,
  server: 7,
  contact: 8,
  arrived: 9,
  status: 10,
  newsletter: 11,
  bookedAt: 12,
  token: 13,
  /** The first of the edit notes, one per cell, continuing to the right. */
  edits: 14,
} as const;

/** Contact Method on a walk-in's row; its Contact is the Square order the check is on. */
const SQUARE = "Square";

/** Statuses that give a table back: staff cancel a booking, and a walk-in has left once its check closes. */
const RELEASED = ["cancelled", "left"];

/** A booking read from the Tracker, with the sheet row it is on. */
export type TrackerBooking = Booking & { row: number };

export const columnLetter = (index: number): string => {
  let letters = "";
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
  }
  return letters;
};

const LAST_COLUMN = columnLetter(TRACKER_COLUMNS.length - 1);

// Sheets appends below the last block of data its range touches, so anchoring
// on the header keeps new rows under the bookings even when something sits far below them.
const HEADER = `A1:${LAST_COLUMN}1`;

const range = (tab: string, cells: string): string => encodeURIComponent(`${tab}!${cells}`);

type Cell = string | number | boolean | undefined;

const SHEETS_EPOCH = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` → the day number Sheets stores for a date cell. */
const dateSerial = (date: string): number => {
  const [year, month, day] = date.split("-").map(Number);
  return (Date.UTC(year, month - 1, day) - SHEETS_EPOCH) / DAY_MS;
};

/** A date cell: a Sheets serial, an ISO string, or a US `M/D/YYYY` someone typed. */
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

/** A time cell: the fraction of a day Sheets stores, or text like `6:30 pm`. */
const cellTime = (cell: Cell): number | null => {
  if (typeof cell === "number") return Math.round((cell - Math.floor(cell)) * 1440);
  return typeof cell === "string" ? parseHHMM(cell) : null;
};

const cellTables = (cell: Cell): string[] => {
  if (typeof cell === "number") return [String(cell)];
  if (typeof cell !== "string") return [];
  return cell
    .toUpperCase()
    .split(/[\s,/+&]+/)
    .filter(Boolean);
};

const cellText = (cell: Cell): string => (cell == null ? "" : String(cell).trim());

const cellNumber = (cell: Cell): number => {
  const value = typeof cell === "number" ? cell : Number(cellText(cell));
  return Number.isFinite(value) ? Math.round(value) : 0;
};

const cellBoolean = (cell: Cell): boolean =>
  cell === true || ["true", "yes", "x", "y", "✓"].includes(cellText(cell).toLowerCase());

const trackerRows = (client: SheetsClient): Promise<Cell[][]> =>
  client<{ values?: Cell[][] }>(
    "GET",
    `/values/${range(TRACKER, `A2:${LAST_COLUMN}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`,
  ).then((response) => response.values ?? []);

type Unassigned = { row: number; date: string; start: number; party: number };

/**
 * Gives a table to bookings staff typed in without one (a phone booking, say)
 * so they hold space like any other, and writes the choice back to the sheet.
 */
const assignUnassigned = async (
  client: SheetsClient,
  bookings: TrackerBooking[],
  unassigned: Unassigned[],
  rules: Rules,
): Promise<void> => {
  const updates: { range: string; values: string[][] }[] = [];
  unassigned.sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start || a.row - b.row);
  for (const entry of unassigned) {
    const hold = holdFor(entry.party, rules);
    const taken = occupiedAt(bookings, entry.date, entry.start, hold, rules);
    const turning = turningAt(bookings, entry.date, entry.start, hold, rules);
    const tables = assignTables(seatingFor(entry.party), taken, rules, turning);
    if (!tables) continue;
    bookings.push({ date: entry.date, start: entry.start, party: entry.party, tables, row: entry.row });
    updates.push({
      range: `${TRACKER}!${columnLetter(COL.tables)}${entry.row}`,
      values: [[tables.join(", ")]],
    });
  }
  if (!updates.length) return;
  try {
    await client("POST", "/values:batchUpdate", { valueInputOption: "RAW", data: updates });
  } catch (error) {
    console.error("Could not write tables back to the Tracker:", error);
  }
};

/** Every booking on or after `today` that still holds a table. */
export const readBookings = async (
  client: SheetsClient,
  rules: Rules,
  today: string,
): Promise<TrackerBooking[]> => {
  const bookings: TrackerBooking[] = [];
  const unassigned: Unassigned[] = [];
  (await trackerRows(client)).forEach((cells, index) => {
    const row = index + 2;
    const date = cellDate(cells[COL.date]);
    const start = cellTime(cells[COL.time]);
    if (!date || start == null || date < today) return;
    if (RELEASED.includes(cellText(cells[COL.status]).toLowerCase())) return;
    const tables = cellTables(cells[COL.tables]);
    const party = cellNumber(cells[COL.party]) || 2;
    const check = cellText(cells[COL.method]) === SQUARE ? cellText(cells[COL.contact]) : "";
    if (tables.length) {
      bookings.push({ date, start, party, tables, row, ...(check ? { check } : {}) });
    } else {
      unassigned.push({ row, date, start, party });
    }
  });
  if (unassigned.length) await assignUnassigned(client, bookings, unassigned, rules);
  return bookings;
};

/** Everything on a booking's row that the form can show or change. */
export type TrackerRow = Booking & {
  row: number;
  name: string;
  method: string;
  contact: string;
  notes: string;
  newsletter: boolean;
  status: string;
};

/** The row whose Token column holds `token`, or null. */
export const findBooking = async (client: SheetsClient, token: string): Promise<TrackerRow | null> => {
  if (!token) return null;
  const rows = await trackerRows(client);
  const index = rows.findIndex((cells) => cellText(cells[COL.token]) === token);
  if (index < 0) return null;
  const cells = rows[index];
  const date = cellDate(cells[COL.date]);
  const start = cellTime(cells[COL.time]);
  if (!date || start == null) return null;
  return {
    row: index + 2,
    date,
    start,
    party: cellNumber(cells[COL.party]) || 2,
    tables: cellTables(cells[COL.tables]),
    name: cellText(cells[COL.name]),
    method: cellText(cells[COL.method]),
    contact: cellText(cells[COL.contact]),
    notes: cellText(cells[COL.notes]),
    newsletter: cellBoolean(cells[COL.newsletter]),
    status: cellText(cells[COL.status]).toLowerCase() || "booked",
  };
};

let trackerSheetId: number | null = null;

const trackerId = async (client: SheetsClient): Promise<number> => {
  if (trackerSheetId != null) return trackerSheetId;
  const response = await client<{ sheets: { properties: { sheetId: number; title: string } }[] }>(
    "GET",
    "?fields=sheets.properties(sheetId,title)",
  );
  const tracker = response.sheets.find((sheet) => sheet.properties.title === TRACKER);
  if (!tracker) throw new Error(`The "${TRACKER}" tab is missing.`);
  trackerSheetId = tracker.properties.sheetId;
  return trackerSheetId;
};

/** Checkboxes for Arrived and Newsletter on `count` booking rows starting at `row`. */
const addCheckboxes = async (client: SheetsClient, row: number, count: number): Promise<void> => {
  const sheetId = await trackerId(client);
  await client("POST", ":batchUpdate", {
    requests: [COL.arrived, COL.newsletter].map((column) => ({
      setDataValidation: {
        range: {
          sheetId,
          startRowIndex: row - 1,
          endRowIndex: row - 1 + count,
          startColumnIndex: column,
          endColumnIndex: column + 1,
        },
        rule: { condition: { type: "BOOLEAN" }, showCustomUi: true },
      },
    })),
  });
};

export type NewBooking = Booking & {
  party: number;
  name: string;
  method: string;
  contact: string;
  notes: string;
  newsletter: boolean;
  arrived?: boolean;
  /** The key in the guest's edit link; blank on rows that can't be edited online. */
  token?: string;
};

/** The first and last row of an append's `updatedRange`, like `Tracker!A33:M34`. */
const writtenRows = (updatedRange = ""): [number, number] | null => {
  const match = updatedRange.match(/![A-Z]+(\d+)(?::[A-Z]+(\d+))?$/);
  if (!match) return null;
  const first = Number(match[1]);
  return [first, Number(match[2] ?? first)];
};

/**
 * Written RAW: dates and times go in as the numbers Sheets stores (the column
 * formats display them), and guest text is stored verbatim — never parsed as a
 * number, a date or a formula. Rejects unless Sheets confirms writing every row.
 */
export const appendBookings = async (
  client: SheetsClient,
  bookings: NewBooking[],
  rules: Rules,
): Promise<void> => {
  if (!bookings.length) return;
  const bookedAt = timestampIn(rules.timezone);
  const values = bookings.map((booking) => {
    const row: Cell[] = [];
    row[COL.date] = dateSerial(booking.date);
    row[COL.name] = booking.name;
    row[COL.time] = booking.start / 1440;
    row[COL.party] = booking.party;
    row[COL.method] = booking.method;
    row[COL.contact] = booking.contact;
    row[COL.notes] = booking.notes;
    row[COL.tables] = booking.tables.join(", ");
    row[COL.server] = "";
    row[COL.arrived] = booking.arrived ?? false;
    row[COL.status] = "booked";
    row[COL.newsletter] = booking.newsletter;
    row[COL.bookedAt] = bookedAt;
    row[COL.token] = booking.token ?? "";
    row[COL.edits] = "";
    return row;
  });
  const response = await client<{ updates?: { updatedRange?: string } }>(
    "POST",
    `/values/${range(TRACKER, HEADER)}:append?valueInputOption=RAW&insertDataOption=OVERWRITE`,
    { range: `${TRACKER}!${HEADER}`, majorDimension: "ROWS", values },
  );
  const rows = writtenRows(response.updates?.updatedRange);
  if (!rows || rows[1] - rows[0] + 1 !== values.length) {
    throw new Error(
      `Sheets didn't confirm writing ${values.length} row(s) to the ${TRACKER}: ${JSON.stringify(response.updates ?? null)}`,
    );
  }
  await addCheckboxes(client, rows[0], values.length).catch((error) => {
    console.error("Could not add checkboxes to the new booking rows:", error);
  });
};

export const appendBooking = (client: SheetsClient, booking: NewBooking, rules: Rules): Promise<void> =>
  appendBookings(client, [booking], rules);

/** The Tracker row for a party seated without a booking. */
export const walkInRow = (walkIn: Booking): NewBooking => ({
  ...walkIn,
  name: "Walk-in",
  method: SQUARE,
  contact: walkIn.check ?? "",
  notes: "",
  newsletter: false,
  arrived: true,
});

/**
 * Brings the Tracker in line with the checks open in Square, and answers with
 * everything that now holds a table: a walk-in with no row gets one, and a
 * walk-in's row is marked `left` once its check has closed. With `tickets`
 * null — Square wasn't asked, or didn't answer — the Tracker stands as it is.
 * Never rejects: a walk-in still holds its table when its row can't be written.
 */
export const syncWalkIns = async (
  client: SheetsClient,
  bookings: TrackerBooking[],
  tickets: OpenTicket[] | null,
  rules: Rules,
): Promise<Booking[]> => {
  if (!tickets) return bookings;
  const { left, seated } = reconcileWalkIns(bookings, tickets, rules);
  try {
    if (left.length) {
      await client("POST", "/values:batchUpdate", {
        valueInputOption: "RAW",
        data: left.map(({ row }) => ({
          range: `${TRACKER}!${columnLetter(COL.status)}${row}`,
          values: [["left"]],
        })),
      });
    }
    await appendBookings(client, seated.map(walkInRow), rules);
  } catch (error) {
    console.error("Could not bring the Tracker's walk-ins in line with Square:", error);
  }
  return [...bookings.filter((booking) => !left.includes(booking)), ...seated];
};

/** The cell after the last one with anything in it on `row`, never left of the Edits column. */
const nextNoteCell = async (client: SheetsClient, row: number): Promise<string> => {
  const response = await client<{ values?: Cell[][] }>(
    "GET",
    `/values/${range(TRACKER, `${row}:${row}`)}?valueRenderOption=UNFORMATTED_VALUE`,
  );
  const filled = response.values?.[0]?.length ?? 0;
  return `${TRACKER}!${columnLetter(Math.max(filled, COL.edits))}${row}`;
};

/** The cells a guest's edit can change. */
export type Changes = Partial<
  Pick<NewBooking, "date" | "start" | "party" | "tables" | "name" | "method" | "contact" | "notes" | "newsletter">
>;

const changeCells = (changes: Changes): { column: number; value: Cell }[] => {
  const cells: { column: number; value: Cell }[] = [];
  if (changes.date !== undefined) cells.push({ column: COL.date, value: dateSerial(changes.date) });
  if (changes.start !== undefined) cells.push({ column: COL.time, value: changes.start / 1440 });
  if (changes.party !== undefined) cells.push({ column: COL.party, value: changes.party });
  if (changes.tables !== undefined) cells.push({ column: COL.tables, value: changes.tables.join(", ") });
  if (changes.name !== undefined) cells.push({ column: COL.name, value: changes.name });
  if (changes.method !== undefined) cells.push({ column: COL.method, value: changes.method });
  if (changes.contact !== undefined) cells.push({ column: COL.contact, value: changes.contact });
  if (changes.notes !== undefined) cells.push({ column: COL.notes, value: changes.notes });
  if (changes.newsletter !== undefined) cells.push({ column: COL.newsletter, value: changes.newsletter });
  return cells;
};

/**
 * Changes a booking's row in place and writes `note` in the first empty cell
 * to the right of it, so what the row used to say is kept on the row itself.
 */
export const updateBooking = async (
  client: SheetsClient,
  row: number,
  changes: Changes,
  note: string,
): Promise<void> => {
  const data = changeCells(changes).map(({ column, value }) => ({
    range: `${TRACKER}!${columnLetter(column)}${row}`,
    values: [[value]],
  }));
  data.push({ range: await nextNoteCell(client, row), values: [[note]] });
  await client("POST", "/values:batchUpdate", { valueInputOption: "RAW", data });
};

/** Sets a booking's Status to cancelled, notes it to the right of the row, and strikes the row through. */
export const cancelBooking = async (client: SheetsClient, row: number, note: string): Promise<void> => {
  await client("POST", "/values:batchUpdate", {
    valueInputOption: "RAW",
    data: [
      { range: `${TRACKER}!${columnLetter(COL.status)}${row}`, values: [["cancelled"]] },
      { range: await nextNoteCell(client, row), values: [[note]] },
    ],
  });
  const sheetId = await trackerId(client);
  await client("POST", ":batchUpdate", {
    requests: [
      {
        repeatCell: {
          range: { sheetId, startRowIndex: row - 1, endRowIndex: row },
          cell: { userEnteredFormat: { textFormat: { strikethrough: true } } },
          fields: "userEnteredFormat.textFormat.strikethrough",
        },
      },
    ],
  }).catch((error) => {
    console.error("Could not strike through the cancelled row:", error);
  });
};
