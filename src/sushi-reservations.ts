(() => {
  const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

  // Assembled at runtime so host-side obfuscators (e.g. Cloudflare email protection) can't rewrite the address.
  document.querySelectorAll<HTMLAnchorElement>(".nd-email").forEach((link) => {
    const address = `${link.dataset.u}@${link.dataset.d}`;
    link.href = `mailto:${address}`;
    link.textContent = address;
  });

  const OPEN_DAYS = [4, 5, 6]; // Thu, Fri, Sat
  const dateInput = byId<HTMLInputElement>("nd-date");
  const dateError = byId("nd-date-error");

  const validateDate = () => {
    if (!dateInput.value) {
      dateInput.setCustomValidity("");
      dateError.classList.remove("visible");
      return;
    }
    const [y, m, d] = dateInput.value.split("-").map(Number);
    const day = new Date(y, m - 1, d).getDay();
    if (OPEN_DAYS.includes(day)) {
      dateInput.setCustomValidity("");
      dateError.classList.remove("visible");
    } else {
      dateInput.setCustomValidity("We serve dinner Thursday, Friday & Saturday only.");
      dateError.classList.add("visible");
    }
  };

  // 'change' fires reliably on mobile date pickers; 'input' covers desktop.
  dateInput.addEventListener("change", validateDate);
  dateInput.addEventListener("input", validateDate);

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

  // Listeners are attached here rather than inline so they survive script-rewriting proxies like Cloudflare Rocket Loader.
  document.querySelectorAll<HTMLInputElement>('input[name="entry.207621246"]').forEach((radio) => {
    radio.addEventListener("change", () => showContact(radio.value === "Email" ? "email" : "phone"));
  });

  const form = byId<HTMLFormElement>("nd-gform");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = byId<HTMLInputElement>("nd-name").value.trim().split(" ")[0];
    const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;

    submitButton.disabled = true;
    submitButton.textContent = "Sending…";

    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("timeout")), 8000);
    });

    Promise.race([
      fetch(form.action, { method: "POST", mode: "no-cors", body: new FormData(form) }),
      timeout,
    ])
      .then(() => {
        byId("nd-form-view").style.display = "none";
        byId("nd-confirm-name").textContent = name || "there";
        byId("nd-confirmation").style.display = "block";
        window.scrollTo({ top: 0, behavior: "smooth" });
      })
      .catch(() => {
        submitButton.disabled = false;
        submitButton.textContent = "Request a table";
        byId("nd-error").style.display = "block";
      });
  });
})();
