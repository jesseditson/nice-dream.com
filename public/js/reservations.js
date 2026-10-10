/* Reservations form behaviors. */

// Default the form's area selection from the ?area query parameter:
// ?area=bar defaults to the bar seats, ?area=dining (or no parameter)
// defaults to the dining room.
(function () {
  const params = new URLSearchParams(window.location.search);
  const bar = document.getElementById("nd-area-bar");
  const dining = document.getElementById("nd-area-dining");
  if (bar && dining) {
    const toBar = params.get("area") === "bar";
    bar.checked = toBar;
    dining.checked = !toBar;
  }
})();