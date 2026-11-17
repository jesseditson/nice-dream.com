(() => {
  const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

  // Assembled at runtime so host-side obfuscators (e.g. Cloudflare email protection) can't rewrite the address.
  document.querySelectorAll<HTMLAnchorElement>(".nd-email").forEach((link) => {
    const address = `${link.dataset.u}@${link.dataset.d}`;
    link.href = `mailto:${address}`;
    link.textContent = address;
  });

  type CheckoutResult = { ok: boolean; error?: string; checkout_url?: string; spots_left?: number | null };
  type Availability = { ok: boolean; on_sale?: boolean; spots_left?: number | null };
  type Receipt = { name: string; summary: string; tickets: boolean };

  const section = byId("tickets");
  const form = byId<HTMLFormElement>("film-form");
  if (!section || !form) return;

  const endpoint = form.dataset.endpoint ?? "/carriers/film-studies";
  const maxPerTicket = Number(form.dataset.max) || 10;
  const ticketInputs = Array.from(form.querySelectorAll<HTMLInputElement>(".film-ticket-count"));
  const donationInput = byId<HTMLInputElement>("film-donation");
  const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const RECEIPT_KEY = "film-studies:receipt";

  const money = (amount: number): string => (Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`);

  form.querySelectorAll<HTMLElement>(".nd-pie-price").forEach((price) => {
    price.textContent = money(Number(price.dataset.price) || 0);
  });

  const setVisible = (element: HTMLElement, visible: boolean) => element.classList.toggle("visible", visible);

  /** Compares the restaurant's wall clock with the screening's start, which is written in its local time. */
  const hasStarted = (): boolean => {
    const starts = section.dataset.starts ?? "";
    if (!starts) return false;
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(new Date());
    const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}` >= starts;
  };

  const showClosedIfStarted = () => {
    if (!hasStarted()) return;
    setVisible(byId("film-closed"), true);
    form.style.display = "none";
    document.querySelectorAll<HTMLElement>("[data-film-sale]").forEach((element) => {
      element.hidden = true;
    });
  };

  /** Guests the screening can still take online; null when there's no limit or it couldn't be checked. */
  let spotsLeft: number | null = null;

  const quantity = (input: HTMLInputElement): number =>
    Math.min(maxPerTicket, Math.max(0, Math.floor(Number(input.value) || 0)));

  const ticketTotal = (): number => ticketInputs.reduce((sum, input) => sum + quantity(input), 0);

  /** Trims `input` so every ticket together stays within the spots left. */
  const fitToSpots = (input: HTMLInputElement) => {
    if (spotsLeft == null) return;
    const others = ticketTotal() - quantity(input);
    input.value = String(Math.max(0, Math.min(quantity(input), spotsLeft - others)));
  };

  const spotsMessage = (left: number): string => `Only ${left} ticket${left === 1 ? "" : "s"} left.`;

  const donation = (): number | null => {
    const raw = donationInput.value.replace(/[$,\s]/g, "");
    if (!raw) return 0;
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
    return Number(raw);
  };

  const describe = (): string => {
    const parts = ticketInputs.flatMap((input) => {
      const count = quantity(input);
      return count ? [`${count} ${input.dataset.name}${count === 1 ? "" : "s"}`] : [];
    });
    const gift = donation();
    if (gift) parts.push(`a ${money(gift)} donation`);
    return parts.join(", ");
  };

  const updateTotal = () => {
    for (const input of ticketInputs) input.value = String(quantity(input));
    const total =
      ticketInputs.reduce((sum, input) => sum + quantity(input) * (Number(input.dataset.price) || 0), 0) +
      (donation() ?? 0);
    byId("film-total").textContent = total ? `Total · ${money(total)}` : "";
  };

  form.querySelectorAll<HTMLButtonElement>(".nd-step").forEach((button) => {
    button.addEventListener("click", () => {
      const input = button.parentElement?.querySelector<HTMLInputElement>(".nd-count");
      if (!input) return;
      const step = Number(button.dataset.step);
      if (step > 0 && spotsLeft != null && ticketTotal() >= spotsLeft) {
        showRefusal(spotsMessage(spotsLeft));
        return;
      }
      input.value = String(quantity(input) + step);
      showRefusal("");
      updateTotal();
    });
  });
  ticketInputs.forEach((input) =>
    input.addEventListener("change", () => {
      fitToSpots(input);
      updateTotal();
    }),
  );
  donationInput.addEventListener("input", updateTotal);

  const showRefusal = (message: string) => {
    const refusal = byId("film-refusal");
    refusal.textContent = message;
    setVisible(refusal, message !== "");
  };

  const applySpots = (left: number | null | undefined) => {
    spotsLeft = typeof left === "number" ? Math.max(0, left) : null;
    const full = spotsLeft === 0;
    setVisible(byId("film-full"), full);
    form.querySelectorAll<HTMLElement>(".film-ticket").forEach((row) => {
      row.hidden = full;
    });
    for (const input of ticketInputs) fitToSpots(input);
    const note = byId("film-spots");
    note.hidden = spotsLeft == null || full || spotsLeft > 10;
    if (!note.hidden && spotsLeft != null) note.textContent = `${spotsLeft} ticket${spotsLeft === 1 ? "" : "s"} left`;
    updateTotal();
  };

  const checkSpots = () => {
    fetch(`${endpoint}?film=${encodeURIComponent(section.dataset.film ?? "")}`, { headers: { accept: "application/json" } })
      .then((response) => (response.ok ? (response.json() as Promise<Availability>) : null))
      .then((result) => {
        if (result?.ok) applySpots(result.spots_left);
      })
      .catch(() => {
        // The carrier checks again when the order is sent.
      });
  };

  const setBusy = (busy: boolean) => {
    submitButton.disabled = busy;
    submitButton.textContent = busy ? "Starting checkout…" : "Continue to payment";
  };

  const remember = (receipt: Receipt) => {
    try {
      sessionStorage.setItem(RECEIPT_KEY, JSON.stringify(receipt));
    } catch {
      // Without storage the confirmation just reads more generally.
    }
  };

  const recall = (): Receipt | null => {
    try {
      const saved = sessionStorage.getItem(RECEIPT_KEY);
      return saved ? (JSON.parse(saved) as Receipt) : null;
    } catch {
      return null;
    }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    showRefusal("");
    byId("film-error").style.display = "none";

    const gift = donation();
    if (gift == null) {
      showRefusal("Enter the donation in dollars, like 20.");
      return;
    }
    if (!ticketInputs.some((input) => quantity(input) > 0) && !gift) {
      showRefusal("Pick a ticket or add a donation.");
      return;
    }

    const tickets: Record<string, number> = {};
    for (const input of ticketInputs) {
      if (quantity(input) && input.dataset.index) tickets[input.dataset.index] = quantity(input);
    }
    const name = byId<HTMLInputElement>("film-name").value.trim();
    const payload = {
      film: section.dataset.film,
      tickets,
      donation: donationInput.value,
      name,
      email: byId<HTMLInputElement>("film-email").value,
      phone: byId<HTMLInputElement>("film-phone").value,
    };
    remember({ name, summary: describe(), tickets: Object.keys(tickets).length > 0 });

    setBusy(true);
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("timeout")), 20000);
    });
    Promise.race([
      fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
      }),
      timeout,
    ])
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        const result = (await response.json()) as CheckoutResult;
        if (!result.ok || !result.checkout_url) {
          if (result.spots_left !== undefined) applySpots(result.spots_left);
          showRefusal(result.error ?? "We couldn't start checkout.");
          showClosedIfStarted();
          setBusy(false);
          return;
        }
        window.location.href = result.checkout_url;
      })
      .catch(() => {
        byId("film-error").style.display = "block";
        setBusy(false);
      });
  });

  // Coming back from Square with the browser's back button restores the page mid-submit.
  window.addEventListener("pageshow", () => setBusy(false));

  const showConfirmation = () => {
    const receipt = recall();
    const lead = byId("film-confirm-lead");
    const strong = (text: string) => {
      const element = document.createElement("strong");
      element.textContent = text;
      return element;
    };
    const first = receipt?.name.split(/\s+/)[0];
    lead.textContent = "";
    lead.append(`Thank you${first ? `, ${first}` : ""}! `);
    if (receipt?.summary) lead.append("Your order is in: ", strong(receipt.summary), ". ");
    else lead.append("Your order is in. ");
    if (!receipt || receipt.tickets) {
      lead.append("See you ", strong(section.dataset.when ?? "at the screening"), " — just give your name when you arrive.");
    }
    byId("film-checkout-title").textContent = "You're all set!";
    byId("film-form-view").hidden = true;
    byId("film-confirmation").hidden = false;
    const reveal = () => section.scrollIntoView({ block: "start", behavior: "instant" });
    if (document.readyState === "complete") reveal();
    else window.addEventListener("load", reveal, { once: true });
  };

  if (new URLSearchParams(window.location.search).has("paid")) {
    showConfirmation();
  } else {
    updateTotal();
    showClosedIfStarted();
    if (!hasStarted()) checkSpots();
  }
})();
