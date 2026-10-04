/**
 * Reading and writing the Tracker tab. Bookings are only ever appended; staff
 * cancel by setting Status, and the Tables and Host Sheet tabs derive from here
 * by formula (see setup.ts).
 */
import type { SheetsClient } from "./google";
import {
  type Booking,
  type Rules,
  assignTables,
  holdFor,
  isIsoDate,
  occupiedAt,
  parseHHMM,
  seatingFor,
  timestampIn,
  turningAt,
} from "./room";

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
  "Contact Method",
  "Contact",
  "Notes",
  "Table(s)",
  "Server",
  "Arrived",
  "Status",
  "Newsletter",
  "Booked At",
];

export const COL = {
  date: 0,
  name: 1,
  time: 2,
  party: 3,
  method: 4,
  contact: 5,
  notes: 6,
  tables: 7,
  server: 8,
  arrived: 9,
  status: 10,
  newsletter: 11,
  bookedAt: 12,
} as const;

export const columnLetter = (index: number): string => String.fromCharCode(65 + index);

const LAST_COLUMN = columnLetter(TRACKER_COLUMNS.length - 1);

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

type Unassigned = { row: number; date: string; start: number; party: number };

/**
 * Gives a table to bookings staff typed in without one (a phone booking, say)
 * so they hold space like any other, and writes the choice back to the sheet.
 */
const assignUnassigned = async (
  client: SheetsClient,
  bookings: Booking[],
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
    bookings.push({ date: entry.date, start: entry.start, party: entry.party, tables });
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
): Promise<Booking[]> => {
  const response = await client<{ values?: Cell[][] }>(
    "GET",
    `/values/${range(TRACKER, `A2:${LAST_COLUMN}`)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`,
  );
  const bookings: Booking[] = [];
  const unassigned: Unassigned[] = [];
  (response.values ?? []).forEach((cells, index) => {
    const date = cellDate(cells[COL.date]);
    const start = cellTime(cells[COL.time]);
    if (!date || start == null || date < today) return;
    if (cellText(cells[COL.status]).toLowerCase() === "cancelled") return;
    const tables = cellTables(cells[COL.tables]);
    const party = cellNumber(cells[COL.party]) || 2;
    if (tables.length) {
      bookings.push({ date, start, party, tables });
    } else {
      unassigned.push({ row: index + 2, date, start, party });
    }
  });
  if (unassigned.length) await assignUnassigned(client, bookings, unassigned, rules);
  return bookings;
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

/** Checkboxes for Arrived and Newsletter on one booking row. */
const addCheckboxes = async (client: SheetsClient, row: number): Promise<void> => {
  const sheetId = await trackerId(client);
  await client("POST", ":batchUpdate", {
    requests: [COL.arrived, COL.newsletter].map((column) => ({
      setDataValidation: {
        range: {
          sheetId,
          startRowIndex: row - 1,
          endRowIndex: row,
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
};

/**
 * Written RAW: dates and times go in as the numbers Sheets stores (the column
 * formats display them), and guest text is stored verbatim — never parsed as a
 * number, a date or a formula.
 */
export const appendBooking = async (
  client: SheetsClient,
  booking: NewBooking,
  rules: Rules,
): Promise<void> => {
  const cells = `A:${LAST_COLUMN}`;
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
  row[COL.bookedAt] = timestampIn(rules.timezone);
  const response = await client<{ updates?: { updatedRange?: string } }>(
    "POST",
    `/values/${range(TRACKER, cells)}:append?valueInputOption=RAW&insertDataOption=OVERWRITE`,
    { range: `${TRACKER}!${cells}`, majorDimension: "ROWS", values: [row] },
  );
  const written = Number(response.updates?.updatedRange?.match(/![A-Z]+(\d+)/)?.[1]);
  if (written) {
    await addCheckboxes(client, written).catch((error) => {
      console.error("Could not add checkboxes to the new booking row:", error);
    });
  }
};
