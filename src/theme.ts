(() => {
  const ANIMATED_SELECTOR = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "p",
    "footer .sqs-block-content",
    '[data-animation-role="image"]:not([data-animation-override])',
    '[data-animation-role="button"]',
    '[data-animation-role="header-element"]',
    '[data-animation-role="content"]',
    '[data-animation-role="date"]',
    '[data-animation-role="section"]',
    '[data-animation-role="quote"]:not([data-animation-override])',
    '[data-animation-role="video"]',
    ".list-item-basic-animation",
    ".list-item-rich-animation",
    ".sqs-block-marquee",
    ".sqs-block-accordion",
    ".sqs-block.sqs-background-enabled",
    ".sqs-block-shape",
  ].join(",");
  const ANIMATION_DURATION = "0.90s";
  const ANIMATION_STAGGER_SECONDS = 0.6;

  const FOCUSABLE_SELECTOR =
    'input,select,textarea,a[href],button,[tabindex],audio[controls],video[controls],[contenteditable]:not([contenteditable="false"]),iframe';
  const SECTION_THEMES = ["white", "white-bold", "light", "light-bold", "dark", "dark-bold", "black", "black-bold", "bright", "bright-inverse"];

  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const isAnimatable = (element: Element) =>
    !element.closest("[data-has-block-animations]") &&
    !element.querySelector("[data-has-block-animations]") &&
    !element.closest(".image-block-outer-wrapper")?.querySelector("[data-animation-override]") &&
    !element.closest(".form-wrapper.hidden, .Marquee-measure");

  const animateContent = async () => {
    const targets = Array.from(document.body.querySelectorAll<HTMLElement>(ANIMATED_SELECTOR)).filter(isAnimatable);
    targets.forEach((element) => element.classList.add("preFade"));
    // Clears the static.css `hideContent` animation that keeps the page invisible until boot.
    document.body.dataset.animationState = "booted";

    await nextFrame();
    targets.forEach((element, index) => {
      element.style.transitionTimingFunction = "ease";
      element.style.transitionDuration = ANIMATION_DURATION;
      element.style.transitionDelay = `${index * (ANIMATION_STAGGER_SECONDS / targets.length)}s`;
    });

    await nextFrame();
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("fadeIn");
          observer.unobserve(entry.target);
        }
      });
    });
    targets.forEach((element) => observer.observe(element));
  };

  const containFocus = (container: HTMLElement) => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const savedTabIndexes = new Map<HTMLElement, number>();
    let reverted = false;

    setTimeout(() => {
      if (reverted) {
        return;
      }
      document.body.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR).forEach((element) => {
        if (!container.contains(element)) {
          savedTabIndexes.set(element, element.tabIndex);
          element.tabIndex = -1;
        }
      });
    });

    return () => {
      reverted = true;
      savedTabIndexes.forEach((tabIndex, element) => {
        element.tabIndex = tabIndex;
      });
      previouslyFocused?.focus();
    };
  };

  const initHeader = (header: HTMLElement) => {
    const menu = header.querySelector<HTMLElement>(".header-menu");
    if (!menu) {
      return;
    }
    const burgers = Array.from(header.querySelectorAll<HTMLElement>(".header-burger-btn"));
    const folders = Array.from(menu.querySelectorAll<HTMLElement>(".header-menu-nav-folder"));
    const firstSection = header.nextElementSibling?.querySelector<HTMLElement>(".page-section, .sqs-empty-section");
    const logo = header.querySelector<HTMLImageElement>(".header-title-logo img");

    let isOpen = false;
    let closedTheme = "";
    let revertFocus: (() => void) | undefined;

    const setBurgersActive = (active: boolean) => {
      burgers.forEach((burger) => {
        burger.classList.toggle("burger--active", active);
        burger.querySelector(".js-header-burger-open-title")?.toggleAttribute("hidden", active);
        burger.querySelector(".js-header-burger-close-title")?.toggleAttribute("hidden", !active);
      });
    };

    const setHeaderTheme = (theme: string) => {
      header.dataset.sectionTheme = theme;
      header.classList.remove(...SECTION_THEMES);
      if (theme) {
        header.classList.add(theme);
      }
    };

    const resetFolders = () => {
      folders.forEach((folder) => {
        folder.scrollTop = 0;
        folder.classList.remove("header-menu-nav-folder--open");
        folder.classList.toggle("header-menu-nav-folder--active", folder.dataset.folder === "root");
        folder.classList.add("transition-disabled");
        setTimeout(() => folder.classList.remove("transition-disabled"));
      });
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeMenu();
      }
    };

    const openMenu = () => {
      if (isOpen) {
        return;
      }
      isOpen = true;
      document.body.classList.add("header--menu-open");
      closedTheme = header.dataset.sectionTheme ?? "";
      setHeaderTheme(menu.dataset.sectionTheme ?? "");
      setBurgersActive(true);
      resetFolders();
      document.addEventListener("keyup", onKeyUp);
      revertFocus = containFocus(header);
    };

    const closeMenu = () => {
      if (!isOpen) {
        return;
      }
      isOpen = false;
      document.body.classList.remove("header--menu-open");
      setHeaderTheme(closedTheme);
      setBurgersActive(false);
      document.removeEventListener("keyup", onKeyUp);
      revertFocus?.();
    };

    const offsetContentBelowHeader = (headerHeight: number) => {
      if (firstSection) {
        firstSection.style.paddingTop = `${headerHeight}px`;
      }
      menu.style.paddingTop = `${headerHeight}px`;
    };

    setBurgersActive(false);
    resetFolders();
    burgers.forEach((burger) => burger.addEventListener("click", () => (isOpen ? closeMenu() : openMenu())));

    document.documentElement.style.scrollBehavior = "smooth";
    if (logo?.complete) {
      offsetContentBelowHeader(header.getBoundingClientRect().height);
    }
    logo?.addEventListener("load", () => offsetContentBelowHeader(header.getBoundingClientRect().height));
    new ResizeObserver(([entry]) => {
      if (getComputedStyle(menu).position === "fixed") {
        offsetContentBelowHeader(entry.contentRect.height);
      }
    }).observe(header);
  };

  const header = document.getElementById("header");
  if (header) {
    initHeader(header);
  }
  animateContent();
})();
