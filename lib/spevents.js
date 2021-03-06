'use strict';

var _ = require('lodash');

/*
 * SP event munging utilities
 */

function SPEventFilter(cfg) {
  this.SP_EVENT_CLASSES = cfg.eventClasses;
  this.SP_EVENT_TYPES = cfg.eventTypes;
  this.SP_COMPLAINT_TYPE = cfg.complaintEventType;
  this.SP_FBEVENT_TYPES = cfg.fbEventTypes;
  this.SP_IMPORTANT_FIELDS = cfg.importantFields;
  this.SEGMENT_EVENT_TYPES = cfg.segmentEventTypeMap;
}

module.exports = SPEventFilter;

// Expects: raw SP webhook event
// Returns: event without the 'msys.message_event' preamble
SPEventFilter.prototype.unpackEvent = function(evt) {
  var rec = evt.msys;
  if (!rec) {
    return null;
  }

  var type = this.SP_EVENT_CLASSES.filter(rec.hasOwnProperty.bind(rec));
  if (type.length == 0) {
    return null;
  }

  return rec[type[0]];
};

// An Array.filter() predicate for events this service cares about.
// Expects: raw SP webhook event
// Returns: true/false
SPEventFilter.prototype.eventIsInteresting = function (evt) {
  var unpacked = this.unpackEvent(evt);
  if (!unpacked) {
    return false
  }

  var evttype = unpacked['type'];

  if (this.SP_EVENT_TYPES.indexOf(evttype) < 0) {
    return false;
  }

  if (evttype == this.SP_COMPLAINT_TYPE && this.SP_FBEVENT_TYPES.indexOf(unpacked.fbtype) < 0) {
    return false;
  }

  return true;
};

// Expects: unpacked SP event
// Returns: segment traits object
// Merge SP rcpt_meta and tags fields into a single traits dictionary
// NOTE: the returned object shares fields with the SP event object
SPEventFilter.prototype.formatSPMetadataForSegment = function (evt) {
  var traits = {
    email: evt.rcpt_to
  };

  if (_.has(evt, 'rcpt_meta')) {
    _.extend(traits, evt.rcpt_meta);
  }

  if (_.has(evt, 'tags')) {
    traits.tags = _.clone(evt.tags);
  }

  return traits;
};
