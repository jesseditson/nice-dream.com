(() => {
  const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

  // Assembled at runtime so host-side obfuscators (e.g. Cloudflare email protection) can't rewrite the address.
  document.querySelectorAll<HTMLAnchorElement>(".nd-email").forEach((link) => {
    const address = `${link.dataset.u}@${link.dataset.d}`;
    link.href = `mailto:${address}`;
    link.textContent = address;
  });

  type Area = "dining" | "bar";
  type Slot = { time: string; label: string; dining: number[]; bar: number[] };
  type Night = { date: string; label: string; slots: Slot[] };
  type Existing = {
    date: string;
    time: string;
    date_label: string;
    time_label: string;
    party_size: number;
    name: string;
    contact_method: "email" | "sms";
    contact: string;
    notes: string;
    newsletter: boolean;
    area: Area;
    editable: boolean;
    reason?: "cancelled" | "passed";
  };
  type Availability = {
    ok: boolean;
    error?: string;
    today: string;
    dates: Night[];
    booking?: Existing | null;
    booking_error?: string;
  };
  type BookingResult = {
    ok: boolean;
    error?: string;
    date_label: string;
    time_label: string;
    party_size: number;
    area: Area;
    large_party: boolean;
    manage_url?: string;
    changed?: boolean;
    cancelled?: boolean;
  };

  const form = byId<HTMLFormElement>("nd-form");
  const endpoint = form.dataset.endpoint ?? "/carriers/reservations";
  const largePartyMin = Number(form.dataset.largePartyMin) || 6;
  const maxParty = Number(form.dataset.maxParty) || 8;
  const barSeats = Number(form.dataset.barSeats) || 0;

  const dateSelect = byId<HTMLSelectElement>("nd-date");
  const timePills = byId("nd-times");
  const partyRadios = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="party"]'));
  const partyMore = byId<HTMLInputElement>("nd-party-more");
  const partyCount = byId<HTMLInputElement>("nd-party-count");
  const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const cancelButton = byId<HTMLButtonElement>("nd-cancel");

  let availability: Availability | null = null;

  // The key from the guest's edit link; cleared when it turns out not to open anything.
  let token = new URLSearchParams(window.location.search).get("token") ?? "";
  let editing: Existing | null = null;
  // The night and seating to select once the form has something to offer, from the booking being edited.
  let wantedDate = "";
  let wantedTime = "";

  const area = (): Area =>
    form.querySelector<HTMLInputElement>('input[name="area"]:checked')?.value === "bar" ? "bar" : "dining";

  const partyLimit = (): number => (area() === "bar" ? barSeats : maxParty);
  const submitLabel = (): string =>
    editing ? "Save changes" : area() === "bar" ? "Book the bar" : "Book a table";

  // 5+ without a number yet still needs a communal table, so price it as the smallest such party.
  const partySize = (): number => {
    const checked = form.querySelector<HTMLInputElement>('input[name="party"]:checked');
    if (!checked) return 0;
    if (checked.value !== "more") return Number(checked.value);
    return Number(partyCount.value) || 5;
  };

  const slotOpen = (slot: Slot, party: number) => slot[area()].includes(party);
  const nightOpen = (night: Night, party: number) => night.slots.some((slot) => slotOpen(slot, party));

  const setVisible = (element: HTMLElement, visible: boolean) => element.classList.toggle("visible", visible);

  const setStatus = (message: string, isError = false) => {
    const status = byId("nd-availability-status");
    status.textContent = message;
    status.classList.toggle("nd-availability-status--error", isError);
    setVisible(status, message !== "");
  };

  const placeholder = (select: HTMLSelectElement, label: string) => {
    const option = new Option(label, "");
    option.disabled = true;
    option.selected = true;
    select.add(option);
    select.disabled = true;
  };

  const selectedTime = (): string =>
    form.querySelector<HTMLInputElement>('input[name="time"]:checked')?.value ?? "";

  const renderTimes = () => {
    const previous = selectedTime() || wantedTime;
    timePills.textContent = "";
    const night = availability?.dates.find((entry) => entry.date === dateSelect.value);
    if (!night) {
      const hint = document.createElement("p");
      hint.className = "nd-field-note";
      hint.textContent = availability ? "Pick a night first." : "Checking what's open…";
      timePills.append(hint);
      return;
    }
    const party = partySize();
    for (const slot of night.slots) {
      const open = slotOpen(slot, party);
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
      if (!open) label.title = "Nothing left at this time";
      timePills.append(input, label);
    }
  };

  // Nights that can't seat the party stay listed but grayed; the first that can is selected.
  const renderDates = () => {
    const previous = dateSelect.value || wantedDate;
    dateSelect.textContent = "";
    if (!availability) {
      placeholder(dateSelect, "Checking what's open…");
      renderTimes();
      return;
    }
    const party = partySize();
    let selected = "";
    for (const night of availability.dates) {
      const open = nightOpen(night, party);
      const option = new Option(open ? night.label : `${night.label} — fully booked`, night.date);
      option.disabled = !open;
      dateSelect.add(option);
      if (open && (night.date === previous || !selected)) selected = night.date;
    }
    if (selected) {
      dateSelect.value = selected;
      dateSelect.disabled = false;
    } else {
      placeholder(
        dateSelect,
        availability.dates.length
          ? `No ${area() === "bar" ? "bar seats" : "tables"} left for a party of ${party} — try another size`
          : "No dinner service in the next few weeks",
      );
    }
    renderTimes();
  };

  // Sizes the chosen area can't seat are struck out; a choice that no longer fits drops to the largest that does.
  const limitPartyPills = () => {
    const limit = partyLimit();
    for (const radio of partyRadios) {
      const smallest = radio.value === "more" ? 5 : Number(radio.value);
      radio.disabled = smallest > limit;
      form.querySelector(`label[for="${radio.id}"]`)?.classList.toggle("nd-pill--off", radio.disabled);
    }
    if (partyRadios.some((radio) => radio.checked && !radio.disabled)) return;
    const largest = partyRadios.filter((radio) => !radio.disabled).pop();
    if (largest) largest.checked = true;
  };

  const updateParty = () => {
    limitPartyPills();
    const more = partyMore.checked;
    const dining = area() === "dining";
    setVisible(byId("nd-party-count-field"), more);
    partyCount.disabled = !more;
    partyCount.required = more;
    partyCount.max = String(partyLimit());
    const party = partySize();
    setVisible(byId("nd-large-party"), dining && party >= largePartyMin && party <= maxParty);
    setVisible(byId("nd-party-too-big"), dining && party > maxParty);
    const barNote = document.getElementById("nd-bar-note");
    if (barNote) setVisible(barNote, !dining);
    submitButton.disabled = party > partyLimit();
    submitButton.textContent = submitLabel();
    renderDates();
  };

  const setContactVisible = (field: HTMLElement, input: HTMLInputElement, visible: boolean) => {
    field.classList.toggle("visible", visible);
    input.required = visible;
    input.disabled = !visible;
    if (!visible) {
      input.value = "";
    }
  };

  const showContact = (type: "email" | "phone") => {
    setContactVisible(byId("nd-email-field"), byId("nd-email"), type === "email");
    setContactVisible(byId("nd-phone-field"), byId("nd-phone"), type === "phone");
  };

  const showTokenNotice = (message: string) => {
    const notice = byId("nd-token-notice");
    notice.textContent = message;
    setVisible(notice, message !== "");
  };

  /** Fills the form with the booking the guest's link opened, and switches it to saving changes. */
  const startEditing = (booking: Existing) => {
    if (!booking.editable) {
      token = "";
      showTokenNotice(
        booking.reason === "cancelled"
          ? "That reservation was cancelled. You're welcome to book a new one below."
          : "That seating has already passed, so it can't be changed online — email us at hello@nice-dream.com if you need a hand.",
      );
      return;
    }
    editing = booking;
    const areaRadio = form.querySelector<HTMLInputElement>(`input[name="area"][value="${booking.area}"]`);
    if (areaRadio) areaRadio.checked = true;
    const party = booking.party_size;
    const partyRadio = partyRadios.find((radio) => radio.value === (party >= 5 ? "more" : String(party)));
    if (partyRadio) partyRadio.checked = true;
    if (party >= 5) partyCount.value = String(party);
    wantedDate = booking.date;
    wantedTime = booking.time;
    byId<HTMLInputElement>("nd-name").value = booking.name;
    const sms = booking.contact_method === "sms";
    byId<HTMLInputElement>(sms ? "nd-pref-sms" : "nd-pref-email").checked = true;
    showContact(sms ? "phone" : "email");
    byId<HTMLInputElement>(sms ? "nd-phone" : "nd-email").value = booking.contact;
    byId<HTMLTextAreaElement>("nd-notes").value = booking.notes;
    byId<HTMLInputElement>("nd-newsletter").checked = booking.newsletter;
    byId("nd-editing-when").textContent = `${booking.date_label} at ${booking.time_label}`;
    setVisible(byId("nd-editing"), true);
    setVisible(cancelButton, true);
  };

  const loadAvailability = async () => {
    setStatus("Checking what's open…");
    try {
      const url = token ? `${endpoint}?token=${encodeURIComponent(token)}` : endpoint;
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(await response.text());
      const result = (await response.json()) as Availability;
      if (!result.ok) throw new Error(result.error);
      availability = result;
      setStatus("");
      // Only the first load fills the form in; a reload after a refusal keeps what the guest typed.
      if (token && !editing) {
        if (result.booking) startEditing(result.booking);
        else {
          token = "";
          showTokenNotice(result.booking_error ?? "We couldn't find that reservation. You can book a new one below.");
        }
      }
    } catch {
      availability = null;
      setStatus("We couldn't load our reservations right now — please email us at hello@nice-dream.com to book.", true);
    }
    updateParty();
  };

  form.querySelectorAll<HTMLInputElement>('input[name="area"], input[name="party"]').forEach((radio) => {
    radio.addEventListener("change", updateParty);
  });
  partyCount.addEventListener("input", updateParty);
  dateSelect.addEventListener("change", renderTimes);

  // Listeners are attached here rather than inline so they survive script-rewriting proxies like Cloudflare Rocket Loader.
  form.querySelectorAll<HTMLInputElement>('input[name="contact_method"]').forEach((radio) => {
    radio.addEventListener("change", () => showContact(radio.value === "email" ? "email" : "phone"));
  });

  const showRefusal = (message: string) => {
    const refusal = byId("nd-refusal");
    refusal.textContent = message;
    setVisible(refusal, message !== "");
  };

  const showConfirmation = (result: BookingResult) => {
    const name = byId<HTMLInputElement>("nd-name").value.trim().split(" ")[0];
    const when = `${result.date_label} at ${result.time_label}`;
    const cancelled = result.cancelled === true;
    byId("nd-confirm-title").innerHTML = cancelled
      ? "Reservation<br>cancelled."
      : result.changed
        ? "All<br>updated."
        : "You're<br>booked.";
    byId("nd-confirm-name").textContent = name || "there";
    byId("nd-confirm-when").textContent = when;
    byId("nd-cancelled-when").textContent = when;
    const solo = result.party_size === 1;
    byId("nd-confirm-party").textContent =
      result.area === "bar"
        ? solo ? "a seat at the bar" : `${result.party_size} seats at the bar`
        : solo ? "a table for one" : `a table for ${result.party_size}`;
    byId("nd-confirm-body").style.display = cancelled ? "none" : "";
    byId("nd-cancelled-body").style.display = cancelled ? "" : "none";
    setVisible(byId("nd-confirm-large"), !cancelled && result.large_party);
    const note = byId("nd-confirm-note");
    note.style.display = cancelled ? "none" : "";
    const manage = byId("nd-manage");
    if (result.manage_url) {
      byId<HTMLAnchorElement>("nd-manage-link").href = result.manage_url;
      byId("nd-manage-hint").textContent = byId<HTMLInputElement>("nd-pref-sms").checked
        ? "keep it somewhere safe, since we only have your number"
        : "it's in your confirmation email too";
    }
    manage.style.display = result.manage_url ? "" : "none";
    byId("nd-manage-fallback").style.display = result.manage_url ? "none" : "";
    byId("nd-form-view").style.display = "none";
    byId("nd-confirmation").style.display = "block";
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const send = (payload: Record<string, unknown>): Promise<BookingResult> => {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("timeout")), 15000);
    });
    return Promise.race([
      fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
      }),
      timeout,
    ]).then(async (response) => {
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()) as BookingResult;
    });
  };

  const setBusy = (busy: boolean, label: string) => {
    submitButton.disabled = busy || partySize() > partyLimit();
    submitButton.textContent = busy ? label : submitLabel();
    cancelButton.disabled = busy;
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    showRefusal("");
    byId("nd-error").style.display = "none";

    const time = selectedTime();
    if (!dateSelect.value) {
      showRefusal("Pick a night that's still open.");
      return;
    }
    if (!time) {
      showRefusal("Pick a time that's still open.");
      return;
    }

    const sms = byId<HTMLInputElement>("nd-pref-sms").checked;
    const payload = {
      ...(editing ? { token } : {}),
      area: area(),
      party_size: partySize(),
      date: dateSelect.value,
      time,
      name: byId<HTMLInputElement>("nd-name").value,
      contact_method: sms ? "sms" : "email",
      email: byId<HTMLInputElement>("nd-email").value,
      phone: byId<HTMLInputElement>("nd-phone").value,
      notes: byId<HTMLTextAreaElement>("nd-notes").value,
      newsletter: byId<HTMLInputElement>("nd-newsletter").checked,
    };

    setBusy(true, editing ? "Saving…" : "Booking…");
    send(payload)
      .then(async (result) => {
        if (!result.ok) {
          showRefusal(result.error ?? "We couldn't take that booking.");
          // The room may have filled while they typed, so reoffer what's left.
          await loadAvailability();
          return;
        }
        showConfirmation(result);
      })
      .catch(() => {
        byId("nd-error").style.display = "block";
      })
      .finally(() => setBusy(false, ""));
  });

  // Cancelling takes two clicks: the first arms the button, and it disarms itself if the second doesn't come.
  const ARMED_LABEL = "Really cancel? Click again to confirm";
  const CANCEL_LABEL = "Cancel reservation";
  let disarm: number | undefined;
  const disarmCancel = () => {
    window.clearTimeout(disarm);
    cancelButton.textContent = CANCEL_LABEL;
    cancelButton.classList.remove("nd-submit--armed");
  };
  cancelButton.addEventListener("click", () => {
    if (!editing) return;
    showRefusal("");
    byId("nd-error").style.display = "none";
    if (!cancelButton.classList.contains("nd-submit--armed")) {
      cancelButton.textContent = ARMED_LABEL;
      cancelButton.classList.add("nd-submit--armed");
      disarm = window.setTimeout(disarmCancel, 8000);
      return;
    }
    disarmCancel();
    setBusy(true, submitLabel());
    cancelButton.textContent = "Cancelling…";
    send({ token, cancel: true })
      .then((result) => {
        if (!result.ok) {
          showRefusal(result.error ?? "We couldn't cancel that reservation.");
          return;
        }
        showConfirmation(result);
      })
      .catch(() => {
        byId("nd-error").style.display = "block";
      })
      .finally(() => {
        setBusy(false, "");
        cancelButton.textContent = CANCEL_LABEL;
      });
  });

  updateParty();
  void loadAvailability();
})();
