/**
 * Whether the form's checkouts have been paid, asked of archival payments one
 * checkout at a time.
 */
import type { CarrierCheckout, CarrierPayments } from "@archival/carrier";

/** How often a checkout someone else started is asked about again. */
export const RECHECK_MINUTES = 5;

const lastAsked = new Map<string, number>();

/** Whether `id` hasn't been asked about in the last RECHECK_MINUTES. */
export const isDue = (id: string, now: number = Date.now()): boolean => {
  const asked = lastAsked.get(id);
  return asked == null || now - asked >= RECHECK_MINUTES * 60_000;
};

/**
 * Each checkout's state, by id. Never rejects: a checkout archival can't
 * answer for is left out, and its row stays as it is.
 */
export const checkoutStates = async (
  payments: CarrierPayments,
  ids: string[],
  now: number = Date.now(),
): Promise<Map<string, CarrierCheckout>> => {
  const states = new Map<string, CarrierCheckout>();
  await Promise.all(
    ids.map(async (id) => {
      lastAsked.set(id, now);
      try {
        states.set(id, await payments.checkout.get(id));
      } catch (error) {
        console.error(`Could not look up pie checkout ${id}:`, error);
      }
    }),
  );
  return states;
};
