/**
 * The checks open in Square right now, which is how the carrier sees a table
 * taken by a party that never booked.
 */
import { type OpenTicket, nowMinutesIn, todayIn } from "./room.ts";

const SEARCH_URL = "https://connect.squareup.com/v2/orders/search";
const SQUARE_VERSION = "2024-11-20";
const TIMEOUT_MS = 4000;
/** A check older than this was left open by mistake; nobody is still at the table. */
const LOOKBACK_MS = 12 * 60 * 60 * 1000;

type SquareOrder = { ticket_name?: string; created_at?: string };

/**
 * Every named check opened in the last few hours and not yet closed, oldest
 * first. Never rejects: when Square can't be reached the form carries on from
 * the Tracker alone.
 */
export const openTickets = async (
  token: string,
  locationId: string,
  timezone: string,
): Promise<OpenTicket[]> => {
  try {
    const response = await fetch(SEARCH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "square-version": SQUARE_VERSION,
      },
      body: JSON.stringify({
        location_ids: [locationId],
        query: {
          filter: {
            state_filter: { states: ["OPEN"] },
            date_time_filter: {
              created_at: { start_at: new Date(Date.now() - LOOKBACK_MS).toISOString() },
            },
          },
          sort: { sort_field: "CREATED_AT", sort_order: "ASC" },
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    const payload = (await response.json()) as { orders?: SquareOrder[] };
    return (payload.orders ?? []).flatMap((order) => {
      const opened = new Date(order.created_at ?? "");
      if (!order.ticket_name || Number.isNaN(opened.getTime())) return [];
      return [
        {
          name: order.ticket_name,
          date: todayIn(timezone, opened),
          start: nowMinutesIn(timezone, opened),
        },
      ];
    });
  } catch (error) {
    console.error("Could not read open checks from Square:", error);
    return [];
  }
};
