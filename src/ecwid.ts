(() => {
  const storeId = 68199089;
  const containerId = `my-store-${storeId}`;

  const getValueSave = (id: string, attribute: string) =>
    document.querySelector(`#${id}`)?.getAttribute(attribute) || "";

  const initializeScripts = () => {
    const initializationScripts: NonNullable<Window["_xnext_initialization_scripts"]> = [
      {
        widgetType: "ProductBrowser",
        id: containerId,
        arg: [
          "categoriesPerRow=3",
          "views=grid(20,3) list(60) table(60)",
          "categoryView=grid",
          "searchView=list",
          `id=${containerId}`,
          `defaultProductId=${getValueSave(containerId, "data-default-product-id")}`,
          `defaultCategoryId=${getValueSave(containerId, "data-default-category-id")}`,
        ],
      },
    ];
    if (document.getElementById(`my-search-${storeId}`)) {
      initializationScripts.push({
        widgetType: "SearchWidget",
        id: `my-search-${storeId}`,
        arg: [`id=my-search-${storeId}`],
      });
    }
    if (document.getElementById(`my-categories-${storeId}`)) {
      initializationScripts.push({
        widgetType: "CategoriesV2",
        id: `my-categories-${storeId}`,
        arg: [`id=my-categories-${storeId}`],
      });
    }
    window._xnext_initialization_scripts = initializationScripts;
  };

  const initEcwidIfNecessary = (container: HTMLElement, reset = false) => {
    if (typeof Ecwid !== "undefined") {
      if (reset) {
        Ecwid.destroy();
        initializeScripts();
      }
      ecwid_onBodyDone();
      Ecwid.init();
      return;
    }

    initializeScripts();
    const script = document.createElement("script");
    script.charset = "utf-8";
    script.type = "text/javascript";
    script.id = "ecwid-script";
    script.onload = () => Ecwid.init();
    script.src = `https://app.ecwid.com/script.js?${storeId}`;
    container.appendChild(script);
  };

  const loadEcwid = () => {
    const container = document.getElementById(containerId);
    if (!container) {
      window.ecwid_nocssrewrite = true;
      initEcwidIfNecessary(document.body);
      return;
    }
    if (container.childNodes.length > 0) {
      return;
    }

    window.ecwid_script_defer = true;
    window.ecwid_dynamic_widgets = true;
    window.css_selectors_prefix = encodeURIComponent(`div#${containerId}`);
    initEcwidIfNecessary(container, true);
  };

  const watch = () => {
    new MutationObserver((mutations) => {
      let dispatchedId: string | undefined;
      for (const mutation of mutations) {
        if (mutation.type !== "attributes") {
          continue;
        }
        const targetId = (mutation.target as Element).id;
        if (dispatchedId && dispatchedId === targetId) {
          return;
        }
        dispatchedId = targetId;
        document.dispatchEvent(new Event("pageChange"));
      }
    }).observe(document.body, { attributes: true, attributeFilter: ["id"] });
  };

  document.addEventListener("pageChange", loadEcwid, false);
  loadEcwid();
  window.onload = watch;
})();
