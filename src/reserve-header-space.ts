(() => {
  const header = document.getElementById("header");
  if (!header) {
    return;
  }

  const setHeaderHeightVar = () => {
    document.documentElement.style.setProperty(
      "--header-height",
      `${header.getBoundingClientRect().height}px`,
    );
  };

  setHeaderHeightVar();
  for (const image of Array.from(header.getElementsByTagName("img"))) {
    if (!image.complete) {
      image.addEventListener("load", setHeaderHeightVar);
    }
  }
})();
