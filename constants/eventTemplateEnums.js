const FILTER_OPERATOR = {
  EQUAL_TO: "equal_to",
  NOT_EQUAL_TO: "not_equal_to",
  BETWEEN: "between",
  WITHIN: "within",
  MORE_THAN: "more_than",
};

/** Save View filter keys allowed for the Events Summary grid. */
const EVENTS_FILTER_FIELD_MAP = {
  eventName: "eventName",
  status: "status",
  eventCategory: "eventCategory",
  eventType: "eventType",
  venue: "venue",
  startDate: "startDate",
  endDate: "endDate",
};

const EVENTS_TEMPLATE_FILTER_KEYS = Object.keys(EVENTS_FILTER_FIELD_MAP);

const EVENTS_TEMPLATE_TYPES = ["eventssummary"];

module.exports = {
  FILTER_OPERATOR,
  EVENTS_FILTER_FIELD_MAP,
  EVENTS_TEMPLATE_FILTER_KEYS,
  EVENTS_TEMPLATE_TYPES,
};
