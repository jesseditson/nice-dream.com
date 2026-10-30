(() => {
  const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

  // Assembled at runtime so host-side obfuscators (e.g. Cloudflare email protection) can't rewrite the address.
  document.querySelectorAll<HTMLAnchorElement>(".nd-email").forEach((link) => {
    const address = `${link.dataset.u}@${link.dataset.d}`;
    link.href = `mailto:${address}`;
    link.textContent = address;
  });

  type Slot = { time: string; label: string; left: number | null };
  type PickupDay = { date: string; label: string; slots: Slot[] };
  type Order = { status: string; name: string; summary: string; pickup: string; checkout_url?: string };
  type Availability = {
    ok: boolean;
    error?: string;
    open: boolean;
    dates: PickupDay[];
    order?: Order;
    order_error?: string;
  };
  type CheckoutResult = { ok: boolean; error?: string; checkout_url?: string };

  const form = byId<HTMLFormElement>("nd-form");
  const endpoint = form.dataset.endpoint ?? "/carriers/pies";
  const maxPerOrder = Number(form.dataset.maxPerOrder) || 6;

  const dateSelect = byId<HTMLSelectElement>("nd-date");
  const timePills = byId("nd-times");
  const pieInputs = Array.from(form.querySelectorAll<HTMLInputElement>(".nd-pie-count"));
  const addOnInput = document.getElementById("nd-add-ons") as HTMLInputElement | null;
  const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;

  let availability: Availability | null = null;

  const money = (amount: number): string =>
    Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`;

  document.querySelectorAll<HTMLElement>(".nd-pie-price").forEach((price) => {
    price.textContent = money(Number(price.dataset.price) || 0);
  });

  const setVisible = (element: HTMLElement, visible: boolean) => element.classList.toggle("visible", visible);

  const setStatus = (message: string, isError = false) => {
    const status = byId("nd-availability-status");
    status.textContent = message;
    status.classList.toggle("nd-availability-status--error", isError);
    setVisible(status, message !== "");
  };

  const quantity = (input: HTMLInputElement): number => Math.max(0, Math.floor(Number(input.value) || 0));
  const pieTotal = (): number => pieInputs.reduce((sum, input) => sum + quantity(input), 0);

  /** Keeps every count whole, the pies within the order limit, and the add-ons within one per pie. */
  const clampCounts = (changed?: HTMLInputElement) => {
    for (const input of pieInputs) input.value = String(quantity(input));
    let over = pieTotal() - maxPerOrder;
    if (over > 0) {
      const order = changed ? [changed, ...pieInputs.filter((input) => input !== changed)] : pieInputs;
      for (const input of order) {
        const cut = Math.min(over, quantity(input));
        input.value = String(quantity(input) - cut);
        over -= cut;
      }
    }
    if (addOnInput) {
      addOnInput.max = String(pieTotal());
      addOnInput.value = String(Math.min(quantity(addOnInput), pieTotal()));
    }
  };

  const updateTotal = () => {
    const pies = pieTotal();
    const subtotal =
      pieInputs.reduce((sum, input) => sum + quantity(input) * (Number(input.dataset.price) || 0), 0) +
      (addOnInput ? quantity(addOnInput) * (Number(addOnInput.dataset.price) || 0) : 0);
    byId("nd-total").textContent = pies
      ? `${pies} ${pies === 1 ? "pie" : "pies"} · ${money(subtotal)} before tax`
      : "";
    renderTimes();
  };

  const selectedTime = (): string =>
    form.querySelector<HTMLInputElement>('input[name="time"]:checked')?.value ?? "";

  const renderTimes = () => {
    const previous = selectedTime();
    timePills.textContent = "";
    const day = availability?.dates.find((entry) => entry.date === dateSelect.value);
    if (!day) {
      const hint = document.createElement("p");
      hint.className = "nd-field-note";
      hint.textContent = availability ? "Pick a day first." : "Checking pickup times…";
      timePills.append(hint);
      return;
    }
    const wanted = Math.max(1, pieTotal());
    for (const slot of day.slots) {
      const open = slot.left == null || slot.left >= wanted;
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "time";
      input.value = slot.time;
      input.id = `nd-time-${slot.time.replace(":", "")}`;
      input.className = "nd-pill-radio";
      input.disabled = !open;
      input.checked = open && slot.time === previous;
      const label = document.createElement("label");
      label.htmlFor = input.id;
      label.className = open ? "nd-pill" : "nd-pill nd-pill--off";
      label.textContent = slot.label;
      if (!open) label.title = slot.left ? `Room for ${slot.left} more` : "This time is full";
      timePills.append(input, label);
    }
  };

  const renderDates = () => {
    const previous = dateSelect.value;
    dateSelect.textContent = "";
    for (const day of availability?.dates ?? []) dateSelect.add(new Option(day.label, day.date));
    if (!dateSelect.options.length) {
      const option = new Option("No pickup days set yet", "");
      option.disabled = true;
      dateSelect.add(option);
    }
    if (previous && availability?.dates.some((day) => day.date === previous)) dateSelect.value = previous;
    dateSelect.disabled = !availability?.dates.length;
    renderTimes();
  };

  const showConfirmation = (order: Order | null, missing = "") => {
    const status = order?.status ?? "";
    const paid = status === "paid";
    const cancelled = status === "cancelled";
    const pending = order != null && !paid && !cancelled;
    byId("nd-confirm-title").innerHTML = paid
      ? "You're<br>all set."
      : cancelled
        ? "Order<br>cancelled."
        : pending
          ? "Almost<br>there."
          : "Hmm.";
    document.querySelectorAll(".nd-confirm-name").forEach((element) => {
      element.textContent = order?.name.split(" ")[0] || "there";
    });
    document.querySelectorAll(".nd-confirm-summary").forEach((element) => {
      element.textContent = order?.summary || "your pies";
    });
    document.querySelectorAll(".nd-confirm-pickup").forEach((element) => {
      element.textContent = order?.pickup || "your pickup day";
    });
    if (order?.checkout_url) byId<HTMLAnchorElement>("nd-checkout-link").href = order.checkout_url;
    byId("nd-confirm-paid").style.display = paid ? "" : "none";
    byId("nd-confirm-pending").style.display = pending ? "" : "none";
    byId("nd-confirm-cancelled").style.display = cancelled ? "" : "none";
    const missingNote = byId("nd-confirm-missing");
    missingNote.textContent = missing;
    missingNote.style.display = missing ? "" : "none";
    byId("nd-form-view").style.display = "none";
    byId("nd-confirmation").style.display = "block";
  };

  const fetchAvailability = async (order: string): Promise<Availability> => {
    const url = order ? `${endpoint}?order=${encodeURIComponent(order)}` : endpoint;
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(await response.text());
    const result = (await response.json()) as Availability;
    if (!result.ok) throw new Error(result.error);
    return result;
  };

  const loadAvailability = async () => {
    setStatus("Checking pickup times…");
    try {
      availability = await fetchAvailability("");
      setStatus("");
      if (!availability.open) {
        setVisible(byId("nd-closed"), true);
        form.style.display = "none";
      }
    } catch {
      availability = null;
      setStatus("We couldn't load pickup times right now — please email us at hello@nice-dream.com to order.", true);
    }
    renderDates();
  };

  // Square sends the guest back the moment they pay, which can be a beat before the order shows as paid.
  const RECHECKS = 4;
  const RECHECK_MS = 3000;

  const loadOrder = async (token: string, attempt = 0) => {
    try {
      const result = await fetchAvailability(token);
      if (!result.order) {
        showConfirmation(null, result.order_error ?? "We couldn't find that order.");
        return;
      }
      showConfirmation(result.order);
      const settled = result.order.status === "paid" || result.order.status === "cancelled";
      if (!settled && attempt < RECHECKS) {
        window.setTimeout(() => void loadOrder(token, attempt + 1), RECHECK_MS);
      }
    } catch {
      showConfirmation(null, "We couldn't look up your order just now — refresh in a moment, or email us at hello@nice-dream.com.");
    }
  };

  form.querySelectorAll<HTMLButtonElement>(".nd-step").forEach((button) => {
    button.addEventListener("click", () => {
      const input = button.parentElement?.querySelector<HTMLInputElement>(".nd-count");
      if (!input) return;
      input.value = String(quantity(input) + Number(button.dataset.step));
      clampCounts(input);
      updateTotal();
    });
  });
  form.querySelectorAll<HTMLInputElement>(".nd-count").forEach((input) => {
    input.addEventListener("change", () => {
      clampCounts(input);
      updateTotal();
    });
  });
  dateSelect.addEventListener("change", renderTimes);

  const showRefusal = (message: string) => {
    const refusal = byId("nd-refusal");
    refusal.textContent = message;
    setVisible(refusal, message !== "");
  };

  const setBusy = (busy: boolean) => {
    submitButton.disabled = busy;
    submitButton.textContent = busy ? "Starting checkout…" : "Continue to payment";
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    showRefusal("");
    byId("nd-error").style.display = "none";

    if (!pieTotal()) {
      showRefusal("Pick at least one pie.");
      return;
    }
    const time = selectedTime();
    if (!dateSelect.value || !time) {
      showRefusal("Pick a pickup time that's still open.");
      return;
    }

    const pies: Record<string, number> = {};
    for (const input of pieInputs) {
      if (quantity(input) && input.dataset.id) pies[input.dataset.id] = quantity(input);
    }
    const payload = {
      pies,
      add_ons: addOnInput ? quantity(addOnInput) : 0,
      date: dateSelect.value,
      time,
      name: byId<HTMLInputElement>("nd-name").value,
      email: byId<HTMLInputElement>("nd-email").value,
      phone: byId<HTMLInputElement>("nd-phone").value,
      notes: byId<HTMLTextAreaElement>("nd-notes").value,
    };

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
          showRefusal(result.error ?? "We couldn't start checkout.");
          // A pickup time may have filled while they chose, so reoffer what's left.
          await loadAvailability();
          setBusy(false);
          return;
        }
        window.location.href = result.checkout_url;
      })
      .catch(() => {
        byId("nd-error").style.display = "block";
        setBusy(false);
      });
  });

  // Coming back from Square with the browser's back button restores the page mid-submit.
  window.addEventListener("pageshow", () => setBusy(false));

  const order = new URLSearchParams(window.location.search).get("order");
  if (order) {
    void loadOrder(order);
  } else {
    clampCounts();
    updateTotal();
    void loadAvailability();
  }
})();
