# Security policy

Please report vulnerabilities privately via GitHub's "Report a vulnerability" button on this repository
(Security → Advisories) or by email to security@thinkhuman.dev. Do not open public issues for security
reports. We aim to acknowledge reports within 72 hours.

Supported versions: the latest minor release.

## Hardening your deployment

Operators should read [docs/security.md](docs/security.md): it lists what Marmot does out of the box
(admin panel restricted to superadmins, CORS/CSRF origin allow-list, Redis-backed rate limiting on login,
password reset and SSO, an audit log, security headers) and the checklist for the pieces only you can
provide (TLS, `trustProxy`, secrets, backups, dependency updates).
