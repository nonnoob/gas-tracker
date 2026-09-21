/* Deployment settings. The Worker URL is filled in after the Worker is
   deployed (Cloudflare → Workers & Pages → your worker → the *.workers.dev
   address, or your custom route).

   The live-price section cannot work without it: Costco's endpoint answers
   with access-control-allow-origin: https://my.costco.ca, so the browser
   blocks a direct call from this page. The history section does not need it —
   that data is a file in this repo. */
window.GAS_CONFIG = {
  // Local development points at `npx wrangler dev --port 8788`.
  WORKER: location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? 'http://127.0.0.1:8788'
    : 'https://gas-tracker.nonnoob.workers.dev',

  // Slots the collector records, for the note under the history chart.
  SLOTS: '11:00 / 17:00 America/Los_Angeles'
};
