(() => {
  const root = document.documentElement;
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  const shrinkWordmark = () => {
    if (document.body.dataset.compact !== undefined) return;
    const progress = Math.min(1, window.scrollY / (window.innerHeight * 0.45));
    root.style.setProperty("--scrolled", progress.toFixed(3));
  };

  // The offset each element was last moved by, so its resting position can be measured through it.
  const floating = new Map<HTMLElement, number>();
  const float = () => {
    if (reducedMotion.matches) return;
    const middle = window.innerHeight / 2;
    floating.forEach((applied, element) => {
      const box = element.getBoundingClientRect();
      const offset = (box.top - applied + box.height / 2 - middle) * Number(element.dataset.depth);
      floating.set(element, offset);
      element.style.setProperty("--float", `${offset.toFixed(1)}px`);
    });
  };

  const floatObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const element = entry.target as HTMLElement;
      if (entry.isIntersecting) floating.set(element, Number.parseFloat(element.style.getPropertyValue("--float")) || 0);
      else floating.delete(element);
    });
    float();
  });
  document.querySelectorAll<HTMLElement>("[data-depth]").forEach((element) => floatObserver.observe(element));

  let pending = false;
  const onScroll = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      shrinkWordmark();
      float();
    });
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  onScroll();

  // The page's light follows whichever section crosses the middle of the screen.
  const lightObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) document.body.dataset.light = (entry.target as HTMLElement).dataset.light;
      });
    },
    { rootMargin: "-50% 0px -50% 0px" },
  );
  document.querySelectorAll<HTMLElement>("main [data-light]").forEach((section) => lightObserver.observe(section));

  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      });
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  document.querySelectorAll(".reveal").forEach((element) => revealObserver.observe(element));
  root.classList.add("js");

  // Event times are written in Yucca Valley's local time, so "now" is read there too.
  const events = document.querySelector<HTMLElement>("[data-events]");
  if (events) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(new Date())
        .map((part) => [part.type, part.value]),
    );
    const now = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
    const items = Array.from(events.querySelectorAll<HTMLElement>("[data-ends]"));
    items.forEach((item) => {
      if (item.dataset.ends! < now) item.remove();
    });
    if (items.every((item) => !item.isConnected)) {
      events.remove();
      document.querySelectorAll('a[href$="#events"]').forEach((link) => link.closest("li")?.remove());
    }
  }

  const viewer = document.querySelector<HTMLDialogElement>(".viewer");
  if (viewer) {
    const tabs = Array.from(viewer.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const panels = Array.from(viewer.querySelectorAll<HTMLElement>('[role="tabpanel"]'));
    const slidesOf = (panel: HTMLElement) => Array.from(panel.querySelectorAll<HTMLElement>(".viewer__slide"));
    const trackOf = (panel: HTMLElement) => panel.querySelector<HTMLElement>(".viewer__track")!;
    const openPanel = () => panels.find((panel) => !panel.hidden)!;
    const motion = (): ScrollBehavior => (reducedMotion.matches ? "instant" : "smooth");

    // Where each track was last sent, so quick repeated steps keep going while it's still scrolling there.
    const headedTo = new Map<HTMLElement, { index: number; at: number }>();

    const showSlide = (panel: HTMLElement, index: number, behavior: ScrollBehavior) => {
      const slide = slidesOf(panel)[index];
      if (!slide) return;
      headedTo.set(panel, { index, at: performance.now() });
      const track = trackOf(panel);
      track.scrollTo({ left: slide.offsetLeft - (track.clientWidth - slide.offsetWidth) / 2, behavior });
    };

    const currentSlide = (panel: HTMLElement) => {
      const track = trackOf(panel);
      const middle = track.scrollLeft + track.clientWidth / 2;
      let closest = 0;
      let distance = Infinity;
      slidesOf(panel).forEach((slide, index) => {
        const away = Math.abs(slide.offsetLeft + slide.offsetWidth / 2 - middle);
        if (away < distance) {
          distance = away;
          closest = index;
        }
      });
      return closest;
    };

    const select = (section: string, index: number, focusTab = false) => {
      tabs.forEach((tab) => {
        const selected = tab.dataset.section === section;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
        if (selected) {
          tab.scrollIntoView({ block: "nearest", inline: "center", behavior: motion() });
          if (focusTab) tab.focus();
        }
      });
      panels.forEach((panel) => (panel.hidden = panel.dataset.section !== section));
      const panel = openPanel();
      const slideCount = slidesOf(panel).length;
      const target = index < 0 ? slideCount - 1 : Math.min(index, slideCount - 1);
      const image = slidesOf(panel)[target]?.querySelector("img");
      if (image) image.loading = "eager";
      showSlide(panel, target, "instant");
      // Photos without width and height attributes take their size only once loaded.
      image
        ?.decode()
        .catch(() => {})
        .finally(() => showSlide(panel, target, "instant"));
    };

    const step = (direction: 1 | -1) => {
      const panel = openPanel();
      const last = headedTo.get(panel);
      const from = last && performance.now() - last.at < 700 ? last.index : currentSlide(panel);
      const next = from + direction;
      if (next >= 0 && next < slidesOf(panel).length) {
        showSlide(panel, next, motion());
        return;
      }
      const neighbor = panels[panels.indexOf(panel) + direction];
      if (neighbor) select(neighbor.dataset.section!, direction === 1 ? 0 : -1);
    };

    document.querySelectorAll<HTMLAnchorElement>(".gallery__link").forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        viewer.showModal();
        select(link.dataset.section!, Number(link.dataset.index));
      });
    });

    tabs.forEach((tab, position) => {
      tab.addEventListener("click", () => select(tab.dataset.section!, 0));
      tab.addEventListener("keydown", (event) => {
        const moves: Record<string, number> = { ArrowRight: position + 1, ArrowLeft: position - 1, Home: 0, End: tabs.length - 1 };
        if (!(event.key in moves)) return;
        event.preventDefault();
        const next = tabs[(moves[event.key] + tabs.length) % tabs.length];
        select(next.dataset.section!, 0, true);
      });
    });

    viewer.querySelectorAll(".viewer__step--prev").forEach((button) => button.addEventListener("click", () => step(-1)));
    viewer.querySelectorAll(".viewer__step--next").forEach((button) => button.addEventListener("click", () => step(1)));
    viewer.querySelector(".viewer__close")?.addEventListener("click", () => viewer.close());
    viewer.addEventListener("click", (event) => {
      if (event.target === viewer) viewer.close();
    });
  }
})();
