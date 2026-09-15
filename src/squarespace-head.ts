(() => {
  const { extractCssRuntimeHash, performanceHash } = (document.currentScript as HTMLScriptElement).dataset;

  globalThis.SQUARESPACE_ROLLUPS = {};

  const register = (name: string, kind: "js" | "css", path: string) => {
    (SQUARESPACE_ROLLUPS[name] ??= {})[kind] = [path];
  };

  register("squarespace-visitor_site_error_reporter", "js", `/assets.squarespace.com/universal/scripts-compressed/visitor-site-error-reporter-857906e2f8b59eb7-min.en-US.js`);
  register("squarespace-extract_css_runtime", "js", `/assets.squarespace.com/universal/scripts-compressed/extract-css-runtime-${extractCssRuntimeHash}-min.en-US.js`);
  register("squarespace-extract_css_moment_js_vendor", "js", `/assets.squarespace.com/universal/scripts-compressed/extract-css-moment-js-vendor-a5cfdec1ae227f33-min.en-US.js`);
  register("squarespace-cldr_resource_pack", "js", `/assets.squarespace.com/universal/scripts-compressed/cldr-resource-pack-2c5e18cab442f0cf-min.en-US.js`);
  register("squarespace-common_vendors_stable", "js", `/assets.squarespace.com/universal/scripts-compressed/common-vendors-stable-784b947826b4c445-min.en-US.js`);
  register("squarespace-common_vendors", "js", `/assets.squarespace.com/universal/scripts-compressed/common-vendors-5001a530f667e618-min.en-US.js`);
  register("squarespace-common", "js", `/assets.squarespace.com/universal/scripts-compressed/common-2bc931760ea9e232-min.en-US.js`);
  register("squarespace-user_account_core", "js", `/assets.squarespace.com/universal/scripts-compressed/user-account-core-cab31650bcf3b4ec-min.en-US.js`);
  register("squarespace-user_account_core", "css", `/css/user-account-core-bd42ce75d5951748-min.en-US.css`);
  register("squarespace-performance", "js", `/assets.squarespace.com/universal/scripts-compressed/performance-${performanceHash}-min.en-US.js`);

  Static.COOKIE_BANNER_CAPABLE = true;
})();
