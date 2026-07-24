# Response envelope

Controllers respond with a plain `{ success: true/false, data }` shape directly — this
service does **not** use the `res.success()`-style helper convention some sibling services
use. Errors go through `next(AppError.xxx(...))` (`errors/AppError.js`) for the shared
`middlewares/response.mw.js`'s `errorHandler` to serialize.

Use `AppError.badRequest/notFound/internalServerError(...)` rather than throwing raw
errors or building response JSON by hand — that's what wires into the shared error
serialization.
