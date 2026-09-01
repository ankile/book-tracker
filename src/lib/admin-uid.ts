// The operator's immutable auth UID — never the email, which is a claimable
// string while signups are open (functions/src/admin.ts and the isOperator
// rule enforce the same pair of checks). Shipping it in the bundle hides
// nothing and is not meant to: the server and rules gates are the ones that
// matter. Kept in its own module so the app prefetch can test for the
// operator without loading the admin console's code.
export const ADMIN_UID = '1Cf0CaNfgnVSvTrF5dYjzRd9Xri2';
