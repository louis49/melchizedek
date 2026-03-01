# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | Yes       |
| < 1.0   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in melchizedek, please report it
through [GitHub Security Advisories](https://github.com/louis49/melchizedek/security/advisories/new).

**Please do NOT open a public issue for security vulnerabilities.**

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response timeline

- **Acknowledgment**: within 48 hours
- **Initial assessment**: within 1 week
- **Fix or mitigation**: depends on severity

## Security Design Principles

melchizedek is designed with these security properties:

- **Offline by default**: no network calls except lazy model downloads on first use
- **No telemetry**: zero tracking, zero analytics
- **Private content redaction**: `<private>` tags are replaced with `[REDACTED]`
- **Read-only source**: never writes to `~/.claude/projects/` (transcript source)
- **Local storage only**: all data in `~/.melchizedek/memory.db` (single SQLite file)
- **Graceful degradation**: each layer (embeddings, reranker) is optional
