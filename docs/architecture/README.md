# Book Tracker architecture guide

This is the public, sanitized map of Book Tracker. It explains the system's
responsibilities, trust boundaries, user journeys, and route access without
publishing deployment identifiers or security-sensitive operating details.

Review these maps whenever the architecture, routes, access model, data flows,
or external integrations change.

## Diagram guide

Each diagram answers one question. SVG is best for inspection and sharing.
Four views use Mermaid source. The aligned route matrix uses a small,
deterministic SVG generator.

| View | Question |
|---|---|
| [System context](system-context.svg) | Who uses Book Tracker, and what kinds of outside services does it depend on? |
| [Application architecture](app-architecture.svg) | Where do the main responsibilities live, and which trust boundaries separate them? |
| [Backend responsibilities](backend-runtime.svg) | How do high-level requests and lifecycle events move through the backend? |
| [Pages and navigation](site-functionality.svg) | How do people move through the site? |
| [Route access matrix](site-access.svg) | Who can read each route, what can be changed there, and how is it reached? |

### System context

[SVG](system-context.svg) · [Mermaid](system-context.mmd) · [PNG](system-context.png)

![Book Tracker system context](system-context.svg)

### Application architecture

[SVG](app-architecture.svg) · [Mermaid](app-architecture.mmd) · [PNG](app-architecture.png)

![Book Tracker application architecture](app-architecture.svg)

### Backend responsibilities and data flows

[SVG](backend-runtime.svg) · [Mermaid](backend-runtime.mmd) · [PNG](backend-runtime.png)

![Book Tracker backend responsibilities and data flows](backend-runtime.svg)

### Pages and navigation

[SVG](site-functionality.svg) · [Mermaid](site-functionality.mmd) · [PNG](site-functionality.png)

![Book Tracker pages and navigation](site-functionality.svg)

### Route access matrix

[SVG](site-access.svg) · [SVG generator](site-access.mjs) · [PNG](site-access.png)

![Book Tracker route access matrix](site-access.svg)

## High-level design

- A managed delivery layer serves the application and published profile pages.
- The browser owns the user interface, session-aware navigation, local caching,
  and offline work.
- Managed identity establishes the signed-in user. Data permissions enforce
  owner scope and validate writes.
- Backend services perform operations that require server-side authorization,
  protected configuration, or access to external integrations.
- Background workers process lifecycle events, cleanup, and deferred work.
- The public profile renderer returns a bounded sharing projection. It does not
  define the browser's private-data permissions.
- Operational telemetry records bounded health and issue signals without
  becoming part of the product's public data model.

## Security model

| Boundary | Public description |
|---|---|
| Private navigation | The interface redirects signed-out users and resumes the requested page after sign-in. Navigation is not the data-security boundary. |
| Browser data access | Authenticated data permissions restrict private reads and writes to the owner and validate data-changing operations. |
| Backend requests | The service handling a request performs authorization and input validation before privileged work. |
| Published profiles | Publication state and a bounded output projection decide what a visitor can receive. Private and missing profiles do not reveal private content. |
| Restricted overview | A server-side authorization check protects operational summaries. Hiding navigation alone is insufficient. |
| External integrations | Server-only credentials remain outside public responses and browser-readable state. |
| Background work | Managed lifecycle events invoke bounded workers. Workers apply the same ownership and retention expectations as interactive operations. |

The detailed security review and operational runbooks are intentionally not
part of this public map package.

## Route catalog

| Route | Main functionality | Access and writes |
|---|---|---|
| `/` | Books in progress, page progress, reading sessions, and timers | Signed-in owner read and write |
| `/finished` | Finished books, search, sorting, filtering, totals, and session correction | Signed-in owner read and write |
| `/me` | Reading analytics, sharing settings, optional integrations, and sign-out | Signed-in owner read and write |
| `/authors` | Rename, classify, merge, and retire authors | Signed-in owner read and write |
| `/isbns` | Find incomplete book information and open the edit dialog | Signed-in owner read and write |
| `/profiles/[username]` | Shared reading statistics, activity, records, yearly data, and links | Anyone when published; the owner can view a private profile; no writes on this page |
| `/admin` | Restricted operational summary | Authorized operator read only; operational access may be audited |

## Public sanitization rules

Keep every source file and rendered image in this directory at the capability
level. Do not add:

- cloud project, account, tenant, region, or environment identifiers;
- deployed endpoint, function, queue, topic, database, collection, table,
  bucket, secret, or runtime identity names;
- credential locations, administrator identifiers, or authorization predicates;
- exact quotas, scaling limits, retention periods, monitoring thresholds, or
  recovery timings;
- known weaknesses, unmitigated failure modes, or details that expand the
  impact of a compromised component;
- private hostnames, network addresses, ports, local filesystem paths, or
  operator contact information.

Use generic responsibility names such as "backend service," "application
data," and "external integration." Put security findings in the local security
review and operational details in the appropriate private runbook.

Frontend route paths remain explicit because the route and access diagrams are
the public site map. Never rely on an undisclosed path for authorization.

## Keeping the maps current

Update the relevant `.mmd` or `.mjs` source whenever a change affects system
responsibilities, trust boundaries, data flows, routes, page reachability,
read access, write access, or external integrations. Regenerate every image in
the same change:

```bash
./docs/architecture/render.sh
```

The renderer writes SVG and PNG versions, then verifies that:

- every application page appears in the navigation diagram and route matrix;
- every Mermaid source has an accessible title and description;
- every SVG and PNG exists and is newer than its source;
- the public sources do not contain common forms of infrastructure identifiers.

Run the verifier directly when checking an existing render:

```bash
node docs/architecture/verify.mjs
```
