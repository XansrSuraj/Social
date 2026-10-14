/* The suites call admin-only handlers directly (api/collect, api/report's write, api/apify-usage, api/health):
   this signs those calls in, the same way the website does — a session token from admin-auth.js. */
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password-123";
const { issue } = require("../admin-auth.js");
const token = issue().token;
module.exports = handler => (req, res) => handler({ ...req, headers: { ...((req && req.headers) || {}), authorization: "Bearer " + token } }, res);
