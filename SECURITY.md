# Security policy

## Supported versions

Security fixes are applied to the latest released minor version. Until `1.0.0`, upgrades may also
contain documented breaking changes.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository:

`Security` → `Advisories` → `Report a vulnerability`

Do not open a public issue for credential disclosure, recording leaks, origin/host bypasses, replay
safety failures, request smuggling, SSRF, or dependency vulnerabilities with a working exploit.

Include affected versions, impact, reproduction steps, and any suggested mitigation. Remove real
secrets and personal data from evidence. You should receive an acknowledgement within seven days.

## Scope notes

MCP Trace is not a DLP product or an authentication server. Reports that demonstrate a bypass of the
documented defaults are in scope; reports whose only claim is that explicitly enabled body recording
can contain sensitive application data are covered by the documented threat model.
