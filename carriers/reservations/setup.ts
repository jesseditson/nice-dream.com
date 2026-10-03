/**
 * Builds the spreadsheet the carrier expects — Tracker, Tables, Host Sheet and
 * a hidden Config tab — the first time it sees one without them, and again
 * whenever the room's shape in objects/dinner.toml changes. Tables and Host
 * Sheet are formulas over Tracker, so rebuilding them loses nothing.
 */
import type { SheetsClient } from "./google";
import { type Rules } from "./room";
import { COL, CONFIG, HOST, TABLES, TRACKER, TRACKER_COLUMNS, columnLetter } from "./sheet";

const SETUP_VERSION = 2;

type SheetInfo = {
  properties: { sheetId: number; title: string };
  conditionalFormats?: unknown[];
};

type Request = Record<string, unknown>;

const HOST_COLUMNS = ["Time", "Name", "Table #", "Party Size", "Server", "Notes", "Arrived"];

/** Everything the derived tabs depend on; a change here rebuilds them. */
const layoutKey = (rules: Rules): string => {
  const windows = [...rules.seatings.entries()]
    .sort(([a], [b]) => a - b)
    .map(([day, { first, last }]) => `${day}:${first}-${last}`)
    .join(",");
  return [
    `v${SETUP_VERSION}`,
    `slot=${rules.slotMinutes}`,
    `hold=${rules.holdMinutes}`,
    `tables=${rules.twoTops}+${rules.fourTops}@${rules.fourTopStart}+${rules.communalTables}`,
    windows,
  ].join(" ");
};

let verifiedLayout: string | null = null;

export const ensureSheet = async (client: SheetsClient, rules: Rules): Promise<void> => {
  const wanted = layoutKey(rules);
  if (verifiedLayout === wanted) return;
  let current = "";
  try {
    const response = await client<{ values?: string[][] }>(
      "GET",
      `/values/${encodeURIComponent(`${CONFIG}!B1`)}`,
    );
    current = String(response.values?.[0]?.[0] ?? "");
  } catch {
    // No Config tab yet: a fresh spreadsheet.
  }
  if (current !== wanted) await buildSheet(client, rules, wanted);
  verifiedLayout = wanted;
};

const listSheets = async (client: SheetsClient): Promise<SheetInfo[]> => {
  const response = await client<{ sheets: SheetInfo[] }>(
    "GET",
    "?fields=sheets(properties(sheetId,title),conditionalFormats)",
  );
  return response.sheets;
};

const tableIds = (rules: Rules): string[] => [
  ...Array.from({ length: rules.twoTops }, (_, index) => String(index + 1)),
  ...Array.from({ length: rules.fourTops }, (_, index) => String(rules.fourTopStart + index)),
  ...Array.from({ length: rules.communalTables }, (_, index) => `C${index + 1}`),
];

/** Matrix columns run from the earliest first seating through the end of the latest last seating. */
const matrixSlots = (rules: Rules): number[] => {
  const windows = [...rules.seatings.values()];
  if (!windows.length) return [];
  const first = Math.min(...windows.map((window) => window.first));
  const last = Math.max(...windows.map((window) => window.last)) + rules.holdMinutes - rules.slotMinutes;
  const slots: number[] = [];
  for (let time = first; time <= last; time += rules.slotMinutes) slots.push(time);
  return slots;
};

const timeFormula = (minutes: number): string => `=TIME(${Math.floor(minutes / 60)},${minutes % 60},0)`;

const tracker = (column: number): string => `${TRACKER}!$${columnLetter(column)}$2:$${columnLetter(column)}`;

/** Who holds table `$A<row>` during the seating in `<column>$3`, on the date in B1. */
const tablesCellFormula = (row: number, column: string): string => {
  const slot = `ROUND(${column}$3*1440)`;
  const start = `ROUND(${tracker(COL.time)}*1440)`;
  return (
    `=IFERROR(TEXTJOIN(" / ",TRUE,FILTER(` +
    `${tracker(COL.name)}&" ("&${tracker(COL.party)}&")",` +
    `${tracker(COL.date)}=$B$1,` +
    `${tracker(COL.status)}<>"cancelled",` +
    `REGEXMATCH(","&SUBSTITUTE(${tracker(COL.tables)}&""," ","")&",",","&$A${row}&","),` +
    `${start}<=${slot},` +
    `${start}+${CONFIG}!$B$2>${slot}` +
    `)),"")`
  );
};

/** The day's reservations in seating order, for the date in B1. */
const hostFormula = (): string =>
  `=IFERROR(SORT(FILTER({` +
  [
    tracker(COL.time),
    tracker(COL.name),
    tracker(COL.tables),
    tracker(COL.party),
    tracker(COL.server),
    tracker(COL.notes),
    `IF(REGEXMATCH(UPPER(${tracker(COL.arrived)}&""),"^(TRUE|X|Y|YES|✓)$"),"✓","")`,
  ].join(",") +
  `},${tracker(COL.date)}=$B$1,${tracker(COL.status)}<>"cancelled"),1,TRUE),"No reservations on this date")`;

const gridRange = (
  sheetId: number,
  rows: [number, number?],
  columns?: [number, number?],
): Record<string, number> => ({
  sheetId,
  startRowIndex: rows[0],
  ...(rows[1] === undefined ? {} : { endRowIndex: rows[1] }),
  ...(columns ? { startColumnIndex: columns[0] } : {}),
  ...(columns && columns[1] !== undefined ? { endColumnIndex: columns[1] } : {}),
});

const formatCells = (range: Record<string, number>, format: Record<string, unknown>): Request => ({
  repeatCell: {
    range,
    cell: { userEnteredFormat: format },
    fields: Object.keys(format)
      .map((key) => `userEnteredFormat.${key}`)
      .join(","),
  },
});

const columnWidths = (sheetId: number, widths: number[]): Request[] =>
  widths.map((pixelSize, index) => ({
    updateDimensionProperties: {
      range: { sheetId, dimension: "COLUMNS", startIndex: index, endIndex: index + 1 },
      properties: { pixelSize },
      fields: "pixelSize",
    },
  }));

const datePicker = (sheetId: number, row: number, column: number): Request[] => [
  formatCells(gridRange(sheetId, [row, row + 1], [column, column + 1]), {
    numberFormat: { type: "DATE", pattern: "dddd, mmmm d yyyy" },
    textFormat: { bold: true },
  }),
  {
    setDataValidation: {
      range: gridRange(sheetId, [row, row + 1], [column, column + 1]),
      rule: { condition: { type: "DATE_IS_VALID" }, showCustomUi: true },
    },
  },
];

const buildSheet = async (client: SheetsClient, rules: Rules, layout: string): Promise<void> => {
  let sheets = await listSheets(client);
  const has = (title: string) => sheets.some((sheet) => sheet.properties.title === title);
  const firstBuild = !has(TRACKER);
  const missing = [TRACKER, TABLES, HOST, CONFIG].filter((title) => !has(title));
  if (missing.length) {
    await client("POST", ":batchUpdate", {
      requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
    });
    sheets = await listSheets(client);
  }
  const sheet = (title: string): SheetInfo => {
    const found = sheets.find((entry) => entry.properties.title === title);
    if (!found) throw new Error(`Could not create the "${title}" tab.`);
    return found;
  };
  const trackerId = sheet(TRACKER).properties.sheetId;
  const tablesId = sheet(TABLES).properties.sheetId;
  const hostId = sheet(HOST).properties.sheetId;
  const configId = sheet(CONFIG).properties.sheetId;

  const ids = tableIds(rules);
  const slots = matrixSlots(rules);
  const matrixTop = 3;
  const matrixRows = ids.map((id, index) => [
    `'${id}`,
    ...slots.map((_, column) => tablesCellFormula(matrixTop + 1 + index, columnLetter(column + 1))),
  ]);

  await client("POST", "/values:batchUpdate", {
    valueInputOption: "USER_ENTERED",
    data: [
      { range: `${TRACKER}!A1`, values: [TRACKER_COLUMNS] },
      {
        range: `${CONFIG}!A1`,
        values: [
          ["Layout", layout],
          ["Hold (minutes)", rules.holdMinutes],
          ["", "Managed by carriers/reservations — edit objects/dinner.toml instead."],
        ],
      },
      {
        range: `${TABLES}!A1`,
        values: [
          ["Date", "=TODAY()"],
          ["Pick a date in B1. A combined 4-top fills both of its rows; two names in one cell means a double booking."],
          ["Table", ...slots.map(timeFormula)],
          ...matrixRows,
        ],
      },
      {
        range: `${HOST}!A1`,
        values: [
          ["Date", "=TODAY()"],
          ["Read-only — mark Server and Arrived on the Tracker tab."],
          HOST_COLUMNS,
          [hostFormula()],
        ],
      },
    ],
  });

  const matrix = gridRange(tablesId, [matrixTop, matrixTop + ids.length], [1, 1 + slots.length]);
  const anchor = `${columnLetter(1)}${matrixTop + 1}`;
  const existingRules = sheet(TABLES).conditionalFormats?.length ?? 0;

  const requests: Request[] = [
    // =TODAY() in the derived tabs should roll over at the restaurant's midnight, not UTC's.
    {
      updateSpreadsheetProperties: {
        properties: { timeZone: rules.timezone },
        fields: "timeZone",
      },
    },

    // Tracker
    {
      updateSheetProperties: {
        properties: { sheetId: trackerId, gridProperties: { frozenRowCount: 1 } },
        fields: "gridProperties.frozenRowCount",
      },
    },
    formatCells(gridRange(trackerId, [0, 1]), { textFormat: { bold: true } }),
    formatCells(gridRange(trackerId, [1], [COL.date, COL.date + 1]), {
      numberFormat: { type: "DATE", pattern: "ddd, mmm d yyyy" },
    }),
    formatCells(gridRange(trackerId, [1], [COL.time, COL.time + 1]), {
      numberFormat: { type: "TIME", pattern: "h:mm am/pm" },
    }),
    // Checkbox validation is added per booking row in sheet.ts: on a whole
    // column it fills every blank cell with FALSE, which Sheets' append then
    // treats as data and skips past.
    {
      setDataValidation: {
        range: gridRange(trackerId, [1], [COL.status, COL.status + 1]),
        rule: {
          condition: {
            type: "ONE_OF_LIST",
            values: [{ userEnteredValue: "booked" }, { userEnteredValue: "cancelled" }],
          },
          showCustomUi: true,
          strict: false,
        },
      },
    },
    ...columnWidths(trackerId, [140, 180, 90, 80, 120, 200, 280, 90, 110, 70, 100, 90, 150]),

    // Tables
    {
      updateSheetProperties: {
        properties: {
          sheetId: tablesId,
          gridProperties: { frozenRowCount: matrixTop, frozenColumnCount: 1 },
        },
        fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
      },
    },
    ...datePicker(tablesId, 0, 1),
    formatCells(gridRange(tablesId, [1, 2]), {
      textFormat: { italic: true, foregroundColor: { red: 0.45, green: 0.45, blue: 0.45 } },
    }),
    formatCells(gridRange(tablesId, [matrixTop - 1, matrixTop]), {
      numberFormat: { type: "TIME", pattern: "h:mm am/pm" },
      textFormat: { bold: true },
      horizontalAlignment: "CENTER",
    }),
    formatCells(gridRange(tablesId, [matrixTop, matrixTop + ids.length], [0, 1]), {
      textFormat: { bold: true },
      horizontalAlignment: "CENTER",
    }),
    formatCells(matrix, {
      wrapStrategy: "CLIP",
      textFormat: { fontSize: 9 },
      horizontalAlignment: "CENTER",
    }),
    ...columnWidths(tablesId, [70, ...slots.map(() => 120)]),
    ...Array.from({ length: existingRules }, (_, index) => ({
      deleteConditionalFormatRule: { sheetId: tablesId, index: existingRules - 1 - index },
    })),
    {
      addConditionalFormatRule: {
        index: 0,
        rule: {
          ranges: [matrix],
          booleanRule: {
            condition: {
              type: "CUSTOM_FORMULA",
              values: [{ userEnteredValue: `=ISNUMBER(SEARCH(" / ",${anchor}))` }],
            },
            format: {
              backgroundColor: { red: 0.94, green: 0.6, blue: 0.6 },
              textFormat: { bold: true },
            },
          },
        },
      },
    },
    {
      addConditionalFormatRule: {
        index: 1,
        rule: {
          ranges: [matrix],
          booleanRule: {
            condition: { type: "NOT_BLANK" },
            format: {
              backgroundColor: { red: 0.98, green: 0.85, blue: 0.62 },
              textFormat: { bold: true },
            },
          },
        },
      },
    },

    // Host Sheet
    {
      updateSheetProperties: {
        properties: { sheetId: hostId, gridProperties: { frozenRowCount: 3 } },
        fields: "gridProperties.frozenRowCount",
      },
    },
    ...datePicker(hostId, 0, 1),
    formatCells(gridRange(hostId, [1, 2]), {
      textFormat: { italic: true, foregroundColor: { red: 0.45, green: 0.45, blue: 0.45 } },
    }),
    formatCells(gridRange(hostId, [2, 3]), { textFormat: { bold: true } }),
    formatCells(gridRange(hostId, [3], [0, 1]), {
      numberFormat: { type: "TIME", pattern: "h:mm am/pm" },
    }),
    ...columnWidths(hostId, [90, 180, 80, 90, 110, 320, 70]),

    // Config
    {
      updateSheetProperties: { properties: { sheetId: configId, hidden: true }, fields: "hidden" },
    },
  ];

  // A brand-new spreadsheet comes with an empty "Sheet1" nobody needs.
  const starter = sheets.find((entry) => entry.properties.title === "Sheet1");
  if (firstBuild && starter) {
    requests.push({ deleteSheet: { sheetId: starter.properties.sheetId } });
  }

  await client("POST", ":batchUpdate", { requests });
};
