# Security Policy

## Supported Versions

We actively maintain security updates for the following versions of Epicenter:

| Version | Supported          |
| ------- | ------------------ |
| 7.x.x   | :white_check_mark: |
| < 7.0   | :x:                |

## Reporting a Vulnerability

We take the security of Epicenter seriously. If you believe you have found a security vulnerability in any Epicenter repository, please report it to us as described below.

### How to Report a Security Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

For security issues, reach out to maintainers or **@braden_w** on our [Discord server](https://go.epicenter.so/discord).

For feedback and fast suggestions, join our [Discord server](https://go.epicenter.so/discord) for quick responses. Our community is always active to help. Please be sure to follow the guidelines.

### What to Include in Your Report

Please include the following information to help us triage your report quickly:

- Type of issue (e.g., remote code execution, API key exposure, cross-site scripting, etc.)
- Full paths of source file(s) related to the manifestation of the issue
- The location of the affected source code (tag/branch/commit or direct URL)
- Any special configuration required to reproduce the issue
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit it

### Security Considerations Specific to Epicenter

Given that Epicenter is a Tauri-based desktop application that handles API keys and sensitive data, we're particularly interested in:

- **API Key Security**: Issues related to how user API keys are stored, transmitted, or exposed
- **Local Data Storage**: Vulnerabilities in how transcriptions and user data are stored locally
- **Tauri IPC**: Security issues in the communication between frontend and backend
- **File System Access**: Unauthorized file system access or path traversal vulnerabilities
- **Audio Processing**: Issues in audio file handling that could lead to code execution
- **Update Mechanism**: Vulnerabilities in the auto-update process
- **Third-party Integrations**: Security issues with LLM provider integrations (OpenAI, Anthropic, etc.)

### What to Expect

- **Response Time**: You will receive an acknowledgment within 48 hours
- **Communication**: We will keep you informed about our progress
- **Collaboration**: We will work with you to understand and validate the issue
- **Resolution**: We aim to release patches as quickly as possible, prioritizing based on severity

## Security Best Practices for Users

While using Epicenter:

1. **API Keys**: Never share your API keys. Epicenter stores them locally and never transmits them to our servers
2. **Updates**: Always keep Epicenter updated to the latest version for security patches
3. **Downloads**: Only download Epicenter from official sources (GitHub releases or our website)
4. **Local Storage**: Be aware that your transcriptions are stored locally—secure your device appropriately

## Disclosure Policy

We follow the principle of [Coordinated Vulnerability Disclosure](https://certcc.github.io/CERT-Guide-to-CVD/):

1. Security issues are handled with highest priority
2. We work privately with reporters to understand and fix issues
3. We coordinate disclosure timing with the reporter
4. We release patches along with security advisories

## Safe Harbor

Any activities conducted in a manner consistent with this policy will be considered authorized conduct and we will not initiate legal action against you. If legal action is initiated by a third party against you in connection with activities conducted under this policy, we will take steps to make it known that your actions were conducted in compliance with this policy.

## License

Epicenter is open source under [AGPL-3.0-or-later](licenses/LICENSE-AGPL-3.0). See the root [LICENSE](LICENSE) index.

---

Thank you for helping keep Epicenter and our users safe! Your efforts to responsibly disclose security issues are greatly appreciated.