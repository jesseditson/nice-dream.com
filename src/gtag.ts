window.dataLayer = window.dataLayer || [];

function gtag(..._args: unknown[]) {
  // gtag.js only recognizes the Arguments object, not a plain array.
  dataLayer.push(arguments);
}

gtag("js", new Date());
gtag("set", "developer_id.dZjQwMz", true);
gtag("config", "UA-214172470-1");
