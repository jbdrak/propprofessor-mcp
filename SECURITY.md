# Security Policy

## Supported Versions

| Version | Supported                     |
| ------- | ----------------------------- |
| 2.9.x   | Yes — current release         |
| 2.8.x   | Yes — receives security fixes |
| 2.7.x   | Security fixes only           |
| < 2.7   | No — please upgrade           |

## Reporting a Vulnerability

If you discover a security issue, please report it privately through [GitHub Security Advisories](https://github.com/jbdrak/propprofessor-mcp/security/advisories/new) so we can fix it before public disclosure. Do not open a public issue.

**What to include:**

- Description of the vulnerability
- Steps to reproduce
- Affected version
- Suggested fix (if any)

## Scope

In scope:

- Authentication bypass or credential exposure in the MCP server
- Injection attacks via tool parameters
- Data leakage between MCP clients sharing the same server process

Out of scope:

- Vulnerabilities in the PropProfessor API itself (report to PropProfessor directly)
- Issues in third-party MCP clients (Claude Desktop, Cursor, etc.)
- User error (e.g., committing `auth.json` to a public repo)

## Response

- Acknowledgment within 48 hours
- Fix or mitigation within 7 days for critical issues
- Disclosure coordinated with the reporter
