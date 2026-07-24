# Templates: two unrelated meanings in this codebase

`models/template.model.js` (`Template`) here is a **grid view template** (saved filters/
columns/Save-View state for the Events/Courses/Registrations grids, per the
`template-filters-columns` skill's convention — `templateType`, `systemDefault` vs
per-user `isDefault`), driven by `services/eventTemplate.service.js` /
`controllers/eventTemplate.controller.js` / `routes/eventTemplate.routes.js`.

This is unrelated to communication-service's `Template` model (mail-merge/email
templates) — don't confuse the two when working across services; check which service's
`Template` model a given task means before touching either.

This service owns grid template storage for the Events Summary grid (`templateType`
`eventssummary`, mounted at `/templates`) per `TEMPLATE_IMPLEMENTATION_PLAYBOOK.md`
(repo root) — that playbook is the authoritative map of which service owns template
storage for which grid across the whole platform; check it before assuming a new grid
here follows the same ownership.
