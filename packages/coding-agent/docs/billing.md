# Billing commands

`diffex billing plans` lists public purchasable catalog identities without inventing prices or commercial terms.
`diffex billing status` reads the current organization's locally confirmed subscription.
Both support `--json`, print data to stdout, and report failures on stderr with a nonzero exit code.
`diffex billing --help` works without authentication.

Sign in using `/login` in the interactive CLI first.
The commands use the existing secure account store and refresh rotating tokens before expiry.
Account credentials are never returned to command rendering, and authenticated requests do not follow redirects.
`DIFFEX_API_URL` uses the existing validated API-origin configuration.
The organization is selected by the authenticated backend actor, not a CLI organization flag or WorkOS ID.

Billing can be disabled or unavailable independently of authentication.
A successful checkout return is not evidence of an active subscription.
These commands are read-only and do not start purchases, create API keys, or open a portal.
JSON output contains an allowlisted summary rather than arbitrary provider or server fields.

Validate with `npm run check` and the targeted `billing-command.test.ts` and `diffex-account-auth.test.ts` tests from the coding-agent package.
