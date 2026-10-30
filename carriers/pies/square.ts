/**
 * Square checkout for an order: a payment link whose order already carries the
 * pies and a scheduled pickup, and a way to tell later whether it was paid.
 * Also finds paid pickup orders placed some other way (the dashboard checkout
 * link, which can only schedule ASAP) and moves their pickup.
 */
const API = "https://connect.squareup.com/v2";
const SQUARE_VERSION = "2024-11-20";
const TIMEOUT_MS = 8000;

export type SquareFetch = typeof fetch;

const square = async <T>(
  token: string,
  path: string,
  body: unknown,
  fetcher: SquareFetch,
  method: "POST" | "PUT" = "POST",
): Promise<T> => {
  const response = await fetcher(`${API}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "square-version": SQUARE_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Square ${path} → ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
};

export type CheckoutRequest = {
  /** Also the order's reference_id, which ties the Square order to its sheet row. */
  token: string;
  locationId: string;
  lineItems: unknown[];
  pickupAt: Date;
  name: string;
  email: string;
  phone: string;
  note: string;
  redirectUrl: string;
};

export type Checkout = { url: string; orderId: string };

export const createCheckout = async (
  accessToken: string,
  request: CheckoutRequest,
  fetcher: SquareFetch = fetch,
): Promise<Checkout> => {
  const response = await square<{ payment_link?: { url?: string; order_id?: string } }>(
    accessToken,
    "/online-checkout/payment-links",
    {
      idempotency_key: request.token,
      order: {
        location_id: request.locationId,
        reference_id: request.token,
        line_items: request.lineItems,
        fulfillments: [
          {
            type: "PICKUP",
            state: "PROPOSED",
            pickup_details: {
              schedule_type: "SCHEDULED",
              pickup_at: request.pickupAt.toISOString(),
              // Square fills the checkout's contact fields from the recipient.
              recipient: {
                display_name: request.name,
                email_address: request.email,
                phone_number: request.phone,
              },
              ...(request.note ? { note: request.note.slice(0, 500) } : {}),
            },
          },
        ],
      },
      checkout_options: {
        redirect_url: request.redirectUrl,
        allow_tipping: true,
        ask_for_shipping_address: false,
      },
    },
    fetcher,
  );
  const url = response.payment_link?.url;
  const orderId = response.payment_link?.order_id;
  if (!url || !orderId) throw new Error(`Square returned no payment link: ${JSON.stringify(response)}`);
  return { url, orderId };
};

export type OrderState = {
  /** DRAFT until the guest pays, then OPEN; COMPLETED once picked up in Square; CANCELED if voided. */
  state: string;
  createdAt: Date | null;
  /** What was charged, tax and tip included, in cents. */
  total: number | null;
};

/**
 * The state of each order, by id. Never rejects: it answers null when Square
 * can't be reached, and the sheet is left as it is.
 */
export const orderStates = async (
  accessToken: string,
  locationId: string,
  orderIds: string[],
  fetcher: SquareFetch = fetch,
): Promise<Map<string, OrderState> | null> => {
  const states = new Map<string, OrderState>();
  try {
    for (let start = 0; start < orderIds.length; start += 100) {
      const response = await square<{
        orders?: { id?: string; state?: string; created_at?: string; total_money?: { amount?: number } }[];
      }>(
        accessToken,
        "/orders/batch-retrieve",
        { location_id: locationId, order_ids: orderIds.slice(start, start + 100) },
        fetcher,
      );
      for (const order of response.orders ?? []) {
        if (!order.id) continue;
        const created = new Date(order.created_at ?? "");
        states.set(order.id, {
          state: order.state ?? "",
          createdAt: Number.isNaN(created.getTime()) ? null : created,
          total: order.total_money?.amount ?? null,
        });
      }
    }
    return states;
  } catch (error) {
    console.error("Could not read pie orders from Square:", error);
    return null;
  }
};

export type PickupOrder = {
  id: string;
  version?: number;
  state?: string;
  created_at?: string;
  reference_id?: string;
  total_money?: { amount?: number };
  line_items?: {
    catalog_object_id?: string;
    quantity?: string;
    modifiers?: { catalog_object_id?: string; quantity?: string }[];
  }[];
  fulfillments?: {
    uid?: string;
    type?: string;
    state?: string;
    pickup_details?: {
      schedule_type?: string;
      pickup_at?: string;
      note?: string;
      recipient?: { display_name?: string; email_address?: string; phone_number?: string };
    };
  }[];
};

/**
 * Every paid pickup order created since `since`, oldest first. Never rejects:
 * it answers null when Square can't be reached.
 */
export const paidPickupOrders = async (
  accessToken: string,
  locationId: string,
  since: Date,
  fetcher: SquareFetch = fetch,
): Promise<PickupOrder[] | null> => {
  const orders: PickupOrder[] = [];
  try {
    let cursor: string | undefined;
    do {
      const response = await square<{ orders?: PickupOrder[]; cursor?: string }>(
        accessToken,
        "/orders/search",
        {
          location_ids: [locationId],
          limit: 500,
          ...(cursor ? { cursor } : {}),
          query: {
            filter: {
              state_filter: { states: ["OPEN", "COMPLETED"] },
              date_time_filter: { created_at: { start_at: since.toISOString() } },
              fulfillment_filter: { fulfillment_types: ["PICKUP"] },
            },
            sort: { sort_field: "CREATED_AT", sort_order: "ASC" },
          },
        },
        fetcher,
      );
      orders.push(...(response.orders ?? []));
      cursor = response.cursor;
    } while (cursor);
    return orders;
  } catch (error) {
    console.error("Could not search Square for pie orders:", error);
    return null;
  }
};

/** Moves an order's pickup to `pickupAt`. Never rejects; a failure is logged and tried again next time. */
export const reschedulePickup = async (
  accessToken: string,
  locationId: string,
  order: PickupOrder,
  fulfillmentUid: string,
  pickupAt: Date,
  fetcher: SquareFetch = fetch,
): Promise<boolean> => {
  try {
    await square(
      accessToken,
      `/orders/${encodeURIComponent(order.id)}`,
      {
        idempotency_key: `${order.id}-${order.version ?? 0}-${pickupAt.getTime()}`.slice(0, 192),
        order: {
          location_id: locationId,
          version: order.version,
          fulfillments: [
            {
              uid: fulfillmentUid,
              pickup_details: { schedule_type: "SCHEDULED", pickup_at: pickupAt.toISOString() },
            },
          ],
        },
      },
      fetcher,
      "PUT",
    );
    return true;
  } catch (error) {
    console.error(`Could not move the pickup of Square order ${order.id}:`, error);
    return false;
  }
};
