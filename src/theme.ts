(() => {
  const ANIMATED_SELECTOR = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "p",
    "footer .block__content",
    '[data-animate="image"]',
    '[data-animate="header-element"]',
  ].join(",");
  const ANIMATION_DURATION = "0.90s";
  const ANIMATION_STAGGER_SECONDS = 0.6;

  const FOCUSABLE_SELECTOR =
    'input,select,textarea,a[href],button,[tabindex],audio[controls],video[controls],[contenteditable]:not([contenteditable="false"]),iframe';

  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const animateContent = async () => {
    const targets = Array.from(document.body.querySelectorAll<HTMLElement>(ANIMATED_SELECTOR));
    targets.forEach((element) => element.classList.add("reveal"));
    // Clears the site.css `hideContent` animation that keeps the page invisible until boot.
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
          entry.target.classList.add("reveal--visible");
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
    const menu = header.querySelector<HTMLElement>(".mobile-menu");
    if (!menu) {
      return;
    }
    const toggles = Array.from(header.querySelectorAll<HTMLElement>(".menu-toggle__button"));
    const folders = Array.from(menu.querySelectorAll<HTMLElement>(".mobile-menu__folder"));
    const firstSection = header.nextElementSibling?.querySelector<HTMLElement>(".page-section");
    const logo = header.querySelector<HTMLImageElement>(".site-header__logo img");

    let isOpen = false;
    let closedTheme = "";
    let revertFocus: (() => void) | undefined;

    const setTogglesActive = (active: boolean) => {
      toggles.forEach((toggle) => {
        toggle.classList.toggle("menu-toggle__button--active", active);
        toggle.querySelector(".menu-toggle__open-label")?.toggleAttribute("hidden", active);
        toggle.querySelector(".menu-toggle__close-label")?.toggleAttribute("hidden", !active);
      });
    };

    const resetFolders = () => {
      folders.forEach((folder) => {
        folder.scrollTop = 0;
        folder.classList.remove("mobile-menu__folder--open");
        folder.classList.toggle("mobile-menu__folder--active", folder.dataset.folder === "root");
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
      document.body.classList.add("menu-open");
      closedTheme = header.dataset.theme ?? "";
      header.dataset.theme = menu.dataset.theme ?? "";
      setTogglesActive(true);
      resetFolders();
      document.addEventListener("keyup", onKeyUp);
      revertFocus = containFocus(header);
    };

    const closeMenu = () => {
      if (!isOpen) {
        return;
      }
      isOpen = false;
      document.body.classList.remove("menu-open");
      header.dataset.theme = closedTheme;
      setTogglesActive(false);
      document.removeEventListener("keyup", onKeyUp);
      revertFocus?.();
    };

    const offsetContentBelowHeader = (headerHeight: number) => {
      if (firstSection) {
        firstSection.style.paddingTop = `${headerHeight}px`;
      }
      menu.style.paddingTop = `${headerHeight}px`;
    };

    setTogglesActive(false);
    resetFolders();
    toggles.forEach((toggle) => toggle.addEventListener("click", () => (isOpen ? closeMenu() : openMenu())));

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

  const header = document.querySelector<HTMLElement>(".site-header");
  if (header) {
    initHeader(header);
  }
  animateContent();
})();
