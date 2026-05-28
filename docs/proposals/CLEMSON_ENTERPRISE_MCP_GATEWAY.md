# Clemson Enterprise MCP Gateway Proposal

**Working name:** TigerMCP  
**Purpose:** A Clemson-governed MCP gateway that exposes approved AI tools to authenticated users, approved AI clients, and approved agentic workflows based on role, relationship to data, data classification, and institutional approval.  
**Prepared:** May 2026

---

## Executive summaries

**For university leadership:** Clemson should create a governed MCP gateway rather than allowing disconnected AI plugins, bots, agents, or local MCP servers to spread across campus. The gateway would make approved AI use safer by centralizing authentication, tool approval, data classification, authorization, and audit logging.

**For IT, security, and data stewards:** TigerMCP should be an identity-aware control plane. It should use Clemson SSO/MFA, OAuth-based authorization, a default-deny tool registry, approved client/agent registration, data-classification rules, relationship-based access checks, audit logs, and segmented tool execution.

**For pilot teams:** Start small with read-only Public and Internal Use tools such as policy search, CCIT knowledge search, service catalog search, library search, and research computing documentation. Add personalized, administrative, and Confidential-data tools only after gateway controls are proven.

---

## 1. Core concept

The Model Context Protocol (MCP) gives AI applications a standard way to discover and call external tools, resources, and prompts. In a university setting, this could let approved AI clients and agents safely use campus services such as knowledge bases, calendars, ticketing, Canvas, library search, research computing documentation, or selected administrative systems.

The proposal is not to create one large all-powerful AI server. It is to create a **Clemson-managed MCP gateway** that controls which tools a user, client, or agent can see and use.

```text
Approved AI client or agent
    -> Clemson MCP Gateway
        -> Policy and authorization checks
            -> Approved campus tool services
                -> University systems and data
```

The gateway becomes the approved path for AI-to-campus-system integration.

---

## 2. Proposed conceptual architecture

```text
+-------------------------------------------------------------+
| Approved AI clients and agents                               |
| ChatGPT Edu, Microsoft Copilot, Clemson assistant,           |
| departmental assistants, research agents, workflow agents,   |
| future approved AI clients                                   |
+-----------------------------+-------------------------------+
                              |
                              v
+-------------------------------------------------------------+
| TigerMCP Gateway                                             |
| SSO/MFA, OAuth, client/agent registration, tool registry,    |
| RBAC/ABAC policy engine, data classification, DLP, logs,     |
| human confirmation, rate limits, emergency tool disable      |
+-----------------------------+-------------------------------+
                              |
                              v
+-------------------------------------------------------------+
| Domain MCP tool services                                     |
| Public knowledge, CCIT, Canvas, advising, library, RCD,      |
| Microsoft 365, research, enrollment, finance, curriculum     |
+-----------------------------+-------------------------------+
                              |
                              v
+-------------------------------------------------------------+
| Systems of record and approved data sources                  |
| Clemson web content, ServiceNow, Canvas, Microsoft 365,      |
| Banner/iROAR where approved, finance/HR where approved,      |
| research systems, departmental databases                     |
+-------------------------------------------------------------+
```

**Architecture principle:** AI clients and agents should not connect directly to Banner/iROAR, Canvas, finance, HR, research systems, or other sensitive systems of record. They should request approved tools through TigerMCP, and TigerMCP should enforce identity, approved client/agent status, role, relationship to data, data classification, logging, and approval rules before a tool is exposed or executed.

The gateway should be remote, HTTPS-based, and integrated with Clemson identity. Sensitive backend tool services should be segmented by data class and business function. Internal network or VPN access can be required for sensitive tools, but network location should not replace identity- and policy-based authorization.

---

## 3. Approved clients, agents, and assistants

“Approved AI clients” should explicitly include **agentic systems**, not just chat interfaces.

| Category     | Meaning                                                                                       | Example posture                                                                     |
| ------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| AI client    | A user-facing approved application that hosts the conversation or workflow                    | ChatGPT Edu, Microsoft Copilot, Clemson web assistant                               |
| AI assistant | A Clemson-facing experience built on an approved client or model                              | Campus help assistant, department assistant, research support assistant             |
| AI agent     | A semi-autonomous or scheduled workflow that can plan, call tools, or act on behalf of a user | Department reporting agent, ticket triage agent, scheduled enrollment-summary agent |

Agents should be registered separately from ordinary clients because they may run scheduled tasks, chain tools, or operate with less moment-by-moment user supervision. They should receive narrower scopes, stronger logging, tighter rate limits, and confirmation requirements for sensitive actions.

---

## 4. Identity and authorization model

TigerMCP should use **profile-conditioned tool access**. A user profile should include more than a simple affiliation label.

| Signal              | Example use                                                                   |
| ------------------- | ----------------------------------------------------------------------------- |
| Identity            | Authenticated Clemson user through SSO/MFA                                    |
| Affiliation         | Student, faculty, staff, affiliate, contractor                                |
| Role                | Instructor, advisor, researcher, fiscal officer, IT support, department chair |
| Relationship        | Own record, assigned advisee, instructor-of-record, department scope          |
| Data classification | Public, Internal Use, Confidential, Restricted                                |
| Client/agent trust  | Approved AI client, approved agent, or blocked/unregistered system            |
| Operation risk      | Read, search, draft, write, delete, send, publish                             |

Tool discovery and tool execution should both enforce policy:

```text
User request or scheduled agent task
  -> authenticate user or responsible service identity
  -> verify approved AI client or agent
  -> evaluate user profile and entitlements
  -> filter visible tools
  -> re-check authorization at tool-call time
  -> execute approved tool
  -> redact, summarize, or constrain output as needed
  -> log decision and result metadata
```

The visible tool list is a usability feature, not a security boundary. A tool must still reject unauthorized calls even if a client or agent attempts to invoke it directly.

---

## 5. Data classification approach

TigerMCP should map every tool to Clemson's data classification model.

| Data class   | MCP posture                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Public       | Best starting point. Safe for early search and retrieval tools.                                                                             |
| Internal Use | Suitable for early pilots when access is authenticated, logged, and approved.                                                               |
| Confidential | Requires data steward approval, strict least privilege, relationship checks, and stronger audit controls.                                   |
| Restricted   | Default deny. Consider only in a dedicated, explicitly approved environment with CCIT Security, data steward, legal, and compliance review. |

The gateway should not allow a tool to expose data above the approved level of the AI client or agent, user role, tool approval, and logging environment.

---

## 6. Initial tool catalog

Start with tools that reduce friction without creating major privacy or records risk.

| Phase                                           | Example tools                                                                                                                      | Notes                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Phase 1: Low-risk read-only                     | Clemson AI guidance search, public policy search, CCIT KB search, service catalog search, library search, RCD documentation search | Public/Internal Use only                                          |
| Phase 2: Personalized read-only                 | My tickets, my calendar, my Canvas courses, instructor course-material lookup                                                      | Own-data or relationship-scoped only                              |
| Phase 3: Administrative and Confidential pilots | Advisor support, department reports, enrollment summaries, curriculum planning, research project document search                   | Data steward and compliance approval required                     |
| Phase 4: Confirmed actions                      | Create ticket, draft email, create calendar event, draft KB article, submit internal form                                          | Human confirmation required; avoid autonomous high-impact actions |

Avoid grades, payroll, financial aid, health data, disciplinary matters, legal records, unrestricted SIS access, and autonomous write operations in the first pilots.

---

## 7. Administrative role examples

Administrative roles are a strong use case because they often need summaries, trends, and planning support rather than unrestricted record-level access.

| Role                            | Example tools                                                                                                                                                                                           | Guardrails                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Department chair                | Enrollment trends, section fill rates, waitlist/demand summaries, course rotation gaps, curriculum-change status, faculty teaching-load summaries, staffing-needs planning, department budget summaries | Department-scope and aggregate-first; no individual student records, grades, payroll detail, or HR records unless separately approved |
| Associate dean                  | Cross-department enrollment, program health, curriculum pipeline, accreditation evidence, resource planning                                                                                             | College-scope only; aggregate reporting by default                                                                                    |
| Business officer                | Budget status summaries, procurement policy lookup, grant/spend category explanations, draft justification language                                                                                     | Financial summaries only; no unrestricted transaction authority or payroll-level detail                                               |
| Program or graduate coordinator | Course schedule gaps, applicant/admit pipeline summaries, milestone tracking, degree requirement explanations                                                                                           | Program-scope only; student-level access requires explicit role and relationship approval                                             |

A department chair might see a tool that answers, “Which required courses are over 90% full next fall?” or “Where are waitlists creating staffing pressure?” The same user should not automatically receive access to individual grades, financial aid, disciplinary records, or unrestricted student records.

---

## 8. Tool registry requirements

Every MCP tool should have a short approval record before production.

| Registry field          | Why it matters                                                  |
| ----------------------- | --------------------------------------------------------------- |
| Tool name and version   | Stable identity and change tracking                             |
| Business owner          | Accountable campus unit                                         |
| Technical owner         | Maintenance and incident response                               |
| Data steward            | Approval for data exposure                                      |
| Data classification     | Public, Internal Use, Confidential, Restricted                  |
| Allowed roles           | Who may use the tool                                            |
| Approved clients/agents | Which clients, assistants, or agents may invoke it              |
| Relationship rules      | Own record, assigned advisee, enrolled course, department scope |
| Allowed operations      | Read, search, draft, write, delete, send                        |
| Required scopes         | Least-privilege OAuth or entitlement scope                      |
| Logging plan            | What is logged, redacted, hashed, retained                      |
| Review date             | Periodic recertification                                        |
| Kill switch             | Fast disable path for incident response                         |

Tool descriptions should be reviewed because tool descriptions influence model behavior. Changes to tool descriptions, input schemas, scopes, or side effects should require reapproval.

---

## 9. Security controls

Minimum controls for a Clemson production gateway:

- Clemson SSO/MFA and registered AI clients/agents only.
- OAuth-based access tokens with audience validation and short lifetimes.
- Default-deny tool registry.
- Role-based, attribute-based, and relationship-based authorization.
- Authorization at both `tools/list` and `tools/call`.
- Stronger restrictions for scheduled or semi-autonomous agents.
- Human confirmation for sensitive reads and all meaningful write actions.
- Prompt-injection defenses for email, documents, Canvas content, tickets, and web content.
- Signed or version-pinned tool manifests to reduce tool-poisoning and rug-pull risk.
- Segmented tool execution by data classification and business domain.
- Parameter validation, output filtering, rate limits, DLP checks, and egress controls.
- Privacy-preserving audit logs with sensitive content redacted or hashed.
- Emergency disable for any tool, client, agent, user group, or upstream connector.

---

## 10. Governance model

TigerMCP should be governed as institutional infrastructure, not as a departmental plugin project.

Recommended stakeholders:

- CCIT and Office of Information Security
- Data Governance, Data Trustees, and Data Stewards
- Registrar and FERPA/privacy stakeholders
- Office of General Counsel and compliance partners
- Research Computing and research compliance partners
- Accessibility, procurement, and CheckIT reviewers
- Faculty, staff, student, and departmental representatives
- System owners for Canvas, Microsoft 365, ServiceNow, Banner/iROAR, finance, HR, library, and research systems

A simple production rule:

> No MCP tool goes live without a named owner, data classification, approved users, approved clients/agents, relationship rules, allowed operations, logging plan, rollback plan, and review date.

---

## 11. Pilot plan

**Step 1: Discovery and charter**  
Define scope, stakeholders, approval path, target AI clients/agents, initial tool list, and non-goals.

**Step 2: Gateway proof of concept**  
Implement SSO, client/agent registration, `tools/list`, `tools/call`, audit logging, and a small Public/Internal Use tool registry.

**Step 3: Low-risk campus tools**  
Launch read-only search tools for Clemson policies, AI guidance, CCIT knowledge, service catalog, library resources, and RCD documentation.

**Step 4: Personalized read-only tools**  
Add my-ticket, my-calendar, and my-course-context tools with delegated access and relationship checks.

**Step 5: Administrative or Confidential pilot**  
Add one carefully selected use case, such as department enrollment summaries, advisor support, or department reporting, with data steward approval and strict scope limits.

**Step 6: Confirmed actions only**  
Add draft or submit workflows only after read-only access is mature. Require visible user confirmation before any action leaves the gateway.

---

## 12. Recommended decision request

Request approval for a limited discovery and proof-of-concept phase:

1. Form a TigerMCP working group.
2. Confirm governance path through CheckIT and IT/security review.
3. Select one approved AI client and one limited agentic workflow for the pilot.
4. Build a small remote MCP gateway proof of concept.
5. Launch only Public/Internal Use read-only tools first.
6. Evaluate security, usability, logs, and support burden before expanding.

The success criterion is not tool count. The success criterion is whether Clemson can safely expose a small number of useful tools through a repeatable, governed pattern.

---

## References and links

- [Model Context Protocol - Architecture Overview](https://modelcontextprotocol.io/docs/learn/architecture)
- [Model Context Protocol - Authorization Specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Clemson AI Tool and University Data Use Guide](https://www.clemson.edu/ai/tools/tool-data-use-guide.html)
- [Clemson Generative AI Guidelines](https://www.clemson.edu/ai/guidelines/)
- [Clemson Data Classification Policy](https://www.clemson.edu/ccit/cybersecurity/policy/data-classification.html)
- [Clemson CheckIT Technology Approval Process](https://www.clemson.edu/ccit/checkit/)
- [Clemson IT Security Standards and Guidelines](https://www.clemson.edu/ccit/cybersecurity/policy/security-standards.html)
- [Clemson Duo Authentication](https://www.clemson.edu/ccit/cybersecurity/how-to/duo-authentication.html)
- [NIST SP 800-207: Zero Trust Architecture](https://csrc.nist.gov/pubs/sp/800/207/final)
- [NSA: Model Context Protocol Security Design Considerations](https://www.nsa.gov/Portals/75/documents/Cybersecurity/CSI_MCP_SECURITY.pdf)
- [OWASP Top 10 for LLM Applications 2025](https://genai.owasp.org/resource/owasp-top-10-for-llm-applications-2025/)
