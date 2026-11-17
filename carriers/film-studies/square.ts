/**
 * A Square payment link for one Film Studies order, and the orders already
 * placed. The order carries a pickup at the screening, so it shows on Square's
 * order list that night under the guest's name.
 */
import type { FilmOrder } from "./order.ts";

const API = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-11-20";
const TIMEOUT_MS = 8000;

export type SquareFetch = typeof fetch;

const square = async <T>(accessToken: string, path: string, body: unknown, fetcher: SquareFetch): Promise<T> => {
  const response = await fetcher(`${API}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      "square-version": SQUARE_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Square ${path} → ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
};

export type CheckoutRequest = {
  /** Also the order's reference_id and the payment link's idempotency key. */
  token: string;
  locationId: string;
  lineItems: unknown[];
  screeningAt: Date;
  name: string;
  email: string;
  phone: string;
  note: string;
  allowTipping: boolean;
  redirectUrl: string;
};

export type Checkout = { url: string; orderId: string };

export const createCheckout = async (
  accessToken: string,
  request: CheckoutRequest,
  fetcher: SquareFetch = fetch,
): Promise<Checkout> => {
  const body = await square<{ payment_link?: { url?: string; order_id?: string } }>(
    accessToken,
    "/online-checkout/payment-links",
    {
      idempotency_key: request.token,
      order: {
        location_id: request.locationId,
        reference_id: request.token,
        line_items: request.lineItems,
        pricing_options: { auto_apply_taxes: true },
        fulfillments: [
          {
            type: "PICKUP",
            state: "PROPOSED",
            pickup_details: {
              schedule_type: "SCHEDULED",
              pickup_at: request.screeningAt.toISOString(),
              // Square fills the checkout's contact fields from the recipient.
              recipient: {
                display_name: request.name,
                email_address: request.email,
                phone_number: request.phone,
              },
              note: request.note.slice(0, 500),
            },
          },
        ],
      },
      checkout_options: {
        redirect_url: request.redirectUrl,
        allow_tipping: request.allowTipping,
        ask_for_shipping_address: false,
      },
    },
    fetcher,
  );
  const url = body.payment_link?.url;
  const orderId = body.payment_link?.order_id;
  if (!url || !orderId) throw new Error(`Square returned no payment link: ${JSON.stringify(body)}`);
  return { url, orderId };
};

/** Every pickup order created since `since`, paid or still at checkout (DRAFT). */
export const pickupOrders = async (
  accessToken: string,
  locationId: string,
  since: Date,
  fetcher: SquareFetch = fetch,
): Promise<FilmOrder[]> => {
  const orders: FilmOrder[] = [];
  let cursor: string | undefined;
  do {
    const page = await square<{ orders?: FilmOrder[]; cursor?: string }>(
      accessToken,
      "/orders/search",
      {
        location_ids: [locationId],
        limit: 500,
        ...(cursor ? { cursor } : {}),
        query: {
          filter: {
            state_filter: { states: ["DRAFT", "OPEN", "COMPLETED"] },
            date_time_filter: { created_at: { start_at: since.toISOString() } },
            fulfillment_filter: { fulfillment_types: ["PICKUP"] },
          },
          sort: { sort_field: "CREATED_AT", sort_order: "ASC" },
        },
      },
      fetcher,
    );
    orders.push(...(page.orders ?? []));
    cursor = page.cursor;
  } while (cursor);
  return orders;
};
