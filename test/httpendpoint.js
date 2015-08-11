var chai = require('chai');
var sinon = require('sinon');
var sinonChai = require('sinon-chai');
var request = require('request');
var winston = require('winston');
var _ = require('lodash');

var segmentLib = require('analytics-node');

var config = require('config');

var App = require('../lib/app');
var SPEventFilter = require('../lib/spevents');
var RcptCache = require('../lib/rcptcache');
var Transform = require('../lib/transform');
var Load = require('../lib/load');

chai.should();
chai.use(sinonChai);

var assert = chai.assert;
var expect = chai.expect;

// ----------------------------------------------------------------------------

function TestContext(next) {
  this.initSegmentClient();

  this.initConfig();

  /*
   * Initialise the objects under test
   * NOTE: see index.js for the production init sequence
   */

  this.rcptcache = new RcptCache();
  this.spEventFilter = new SPEventFilter(this.spConfig);
  var transform = new Transform(this.rcptcache, this.spEventFilter, this.spConfig, winston);
  this.load = new Load(this.segmentClient, this.spEventFilter, this.spConfig, winston);

  this.app = new App(
    transform.transform.bind(transform),
    this.load.load.bind(this.load),
    this.rcptcache,
    config,
    winston);

  this.server = this.app.listen(3000, next);
}

/*
 * Stub out the Segment.com client unless we're doing a live test
 */
TestContext.prototype.initSegmentClient = function () {
  if (process.env.NODE_ENV == 'livetest') {
    this.segmentClient = new segmentLib(config.get('segmentAPI.key'), config.get('segmentAPI.opts'));
    sinon.spy(this.segmentClient, 'identify');
    sinon.spy(this.segmentClient, 'track');
  } else {
    this.segmentClient = {
      identify: sinon.spy(function (args, next) {
        process.nextTick(
          function() { next(null); }
        );
      }),
      track: sinon.spy(function (args, next) {
        process.nextTick(
          function() { next(null); }
        );
      }),
      flush: sinon.spy(function (next) {
        process.nextTick(
          function() { next(null); }
        );
      })
    };
  }
};

/*
 * Futz with config and test data to support legacy (pre 4.2) event naming
 */
TestContext.prototype.initConfig = function() {
  this.legacyMode = config.get('legacyMode');
  var spConfigKey = this.legacyMode ? 'sparkPostLegacy' : 'sparkPost';
  this.spConfig = config.get(spConfigKey);

  this.RECEPTION_EVENT = this.legacyMode ? 'reception' : 'injection';
  this.INBAND_EVENT = this.legacyMode ? 'inband' : 'bounce';
  this.FEEDBACK_EVENT = this.legacyMode ? 'feedback' : 'spam_complaint';
  this.OOB_EVENT = this.legacyMode ? 'outofband' : 'out_of_band';

  if (this.legacyMode) {
    // Transmission API: reception, open, click, delivery
    this.TEST_EVENTS_1 = require('./testevents1.json');
    // Transmission API: reception, tempfail, tempfail, inband
    this.TEST_EVENTS_2 = require('./testevents2.json');
  } else {
    // Transmission API: reception, open, click, delivery
    this.TEST_EVENTS_1 = require('./testevents1-4.2.json');
    // Transmission API: reception, tempfail, tempfail, inband
    this.TEST_EVENTS_2 = require('./testevents2-4.2.json');
  }
};

// Shutdown the app server after testing
TestContext.prototype.stop = function (next) {
  this.server.close(next);
};

// Call the app server's webhook endpoint as part of a test
TestContext.prototype.callWebhookEndpoint = function (events, next) {
  request({
    uri: 'http://localhost:3000/api/v1/events',
    method: 'POST',
    json: events
  }).on('response', next);
};

// Call the app server's webhook endpoint and return the HTTP resposne for testing
TestContext.prototype.testResponseToEventTypes = function (eventset, evtTypes, next) {
  var self = this;
  var events;
  if (typeof evtTypes == 'string') {
    events = eventset.filter(function (elt) {
      return elt.msys.message_event && elt.msys.message_event.type == evtTypes;
    });
  } else {
    // assumption: evtTypes is an array of strings
    events = eventset.filter(function (elt) {
      var type;
      if (elt.msys.message_event) {
        type = elt.msys.message_event.type;
      } else if (elt.msys.track_event) {
        type = elt.msys.track_event.type;
      } else if (elt.msys.gen_event) {
        type = elt.msys.gen_event.type;
      } else {
        console.warn('Unexpected event class: ' + JSON.stringify(Object.keys(elt.msys)));
        return false;
      }
      return evtTypes.indexOf(type) >= 0;
    });
  }

  self.callWebhookEndpoint(events, function (resp) {
    self.load.flushSegmentCache(function (err, batch) {
      assert(err == null, 'Segment.flush failed: ' + err);
      next(resp, err, batch);
    });
  });
};

// ----------------------------------------------------------------------------

if (process.env.NODE_ENV == 'livetest') {
  console.log("*** LIVE TEST MODE ***");
}

beforeEach('Start new webhook endpoint service', function(next) {
  this.cxt = new TestContext(next);
});

afterEach('Shutdown webhook endpoint service', function (next) {
  this.cxt.stop(next);
  this.cxt = null;
});

describe('SparkPost webhook endpoint', function () {
  it('/inbound accepts JSON POST requests', function (done) {
    var self = this;
    self.cxt.callWebhookEndpoint(self.cxt.TEST_EVENTS_1, function (resp) {
      expect(resp.statusCode).to.equal(200);
      done();
    });
  });

  it('returns 404 for other endpoints', function (done) {
    request('http://localhost:3000/jimbojumbochops').on('response', function(resp) {
      expect(resp.statusCode).to.equal(404);
      done();
    });
  });

  it('quietly accepts a webhook ping request', function (done) {
    request({
      uri: 'http://localhost:3000/api/v1/events',
      method: 'POST',
      json: {msys:{}}
    }).on('response', function (resp) {
      expect(resp.statusCode).to.equal(200);
      done();
    });
  });
});

describe('Segment.com client', function () {
  it('makes 1 segment.identify call per inbound email address', function (done) {
    var self = this;
    self.cxt.testResponseToEventTypes(self.cxt.TEST_EVENTS_1, self.cxt.RECEPTION_EVENT, function (resp, err, batch) {
      self.cxt.segmentClient.identify.should.have.callCount(1);
      done();
    });
  });

  it('makes 1 segment.track("Email Delivered") call for each received delivery event', function (done) {
    var self = this;
    self.cxt.testResponseToEventTypes(self.cxt.TEST_EVENTS_1, [self.cxt.RECEPTION_EVENT, 'delivery'], function (resp, err, batch) {
      self.cxt.segmentClient.track.should.have.callCount(1);
      expect(self.cxt.segmentClient.track).to.be.calledWith(sinon.match({event: 'Email Delivered'}));
      done();
    });
  });

  it('makes 1 segment.track("Email Bounced") call for each received inband bounce event', function (done) {
    var self = this;
    self.cxt.testResponseToEventTypes(self.cxt.TEST_EVENTS_2, [self.cxt.RECEPTION_EVENT, self.cxt.INBAND_EVENT], function (resp, err, batch) {
      self.cxt.segmentClient.track.should.have.callCount(1);
      expect(self.cxt.segmentClient.track).to.be.calledWith(sinon.match({event: 'Email Bounced'}));
      done();
    });
  });

  it.skip('makes 1 segment.track("Email Bounced") call for each received out_of_band event', function (done) {
    var self = this;
    self.cxt.testResponseToEventTypes(self.cxt.TEST_EVENTS_2, [self.cxt.RECEPTION_EVENT, 'delivery', self.cxt.OOB_EVENT], function (resp, err, batch) {
      self.cxt.segmentClient.track.should.have.callCount(2);
      expect(self.cxt.segmentClient.track).to.be.calledWith(sinon.match({event: 'Email Bounced'}));
      done();
    });
  });

  it.skip('makes 1 segment.track("Email Marked as Spam") call for each received feedback/abuse event', function (done) {
    var self = this;
    self.cxt.testResponseToEventTypes(self.cxt.TEST_EVENTS_1, [self.cxt.RECEPTION_EVENT, 'delivery', self.cxt.FEEDBACK_EVENT], function (resp, err, batch) {
      expect(self.cxt.segmentClient.track).to.be.calledWith(sinon.match({event: 'Email Marked as Spam'}));
      done();
    });
  });

  it('makes 1 segment.track("Email Opened") call for each received open event', function (done) {
    var self = this;
    self.cxt.testResponseToEventTypes(self.cxt.TEST_EVENTS_1, [self.cxt.RECEPTION_EVENT, 'delivery', 'open'], function (resp, err, batch) {
      self.cxt.segmentClient.track.should.have.callCount(2);
      expect(self.cxt.segmentClient.track).to.be.calledWith(sinon.match({event: 'Email Opened'}));
      done();
    });
  });

  it('makes 1 segment.track("Email Link Clicked") call for each received click event', function (done) {
    var self = this;
    self.cxt.testResponseToEventTypes(self.cxt.TEST_EVENTS_1, [self.cxt.RECEPTION_EVENT, 'delivery', 'open', 'click'], function (resp, err, batch) {
      self.cxt.segmentClient.track.should.have.callCount(3);
      expect(self.cxt.segmentClient.track).to.be.calledWith(sinon.match({event: 'Email Link Clicked'}));
      done();
    });
  });

  it('drops delivery events whose message_ids do not have cached rcpt_tos', function (done) {
    var self = this;
    var evt = {
      msys: {
        message_event: {
          type: 'delivery',
          message_id: 'billyjoejimbob'
        }
      }
    }

    self.cxt.callWebhookEndpoint([evt], function (resp) {
      self.cxt.load.flushSegmentCache(function (err, batch) {
        self.cxt.segmentClient.identify.should.have.callCount(0);
        self.cxt.segmentClient.track.should.have.callCount(0);
        done();
      });
    });
  });

  it('drops open events whose message_ids do not have cached rcpt_tos', function (done) {
    var self = this;

    if (!self.cxt.legacyMode) {
      return done();
    }

    self.cxt.testResponseToEventTypes(self.cxt.TEST_EVENTS_1, ['open'], function (resp, err, batch) {
      self.cxt.segmentClient.identify.should.have.callCount(0);
      self.cxt.segmentClient.track.should.have.callCount(0);
      done();
    });
  });

  it('drops click events whose message_ids do not have cached rcpt_tos', function (done) {
    var self = this;

    if (!self.cxt.legacyMode) {
      return done();
    }

    self.cxt.testResponseToEventTypes(self.cxt.TEST_EVENTS_1, ['click'], function (resp, err, batch) {
      self.cxt.segmentClient.identify.should.have.callCount(0);
      self.cxt.segmentClient.track.should.have.callCount(0);
      done();
    });
  });

  it('is resilient to non-array json requests', function (done) {
    this.cxt.callWebhookEndpoint({invalid:'object'}, function (resp) {
      expect(resp.statusCode).to.equal(500);
      done();
    });
  });

  it('quietly accepts empty json arrays in requests', function (done) {
    this.cxt.callWebhookEndpoint([], function (resp) {
      expect(resp.statusCode).to.equal(200);
      done();
    });
  });

  it('ignores malformed events in requests', function (done) {
    var badbatch = _.cloneDeep(this.cxt.TEST_EVENTS_1);
    badbatch[0] = {invalid: 'object'};
    this.cxt.callWebhookEndpoint(badbatch, function (resp) {
      expect(resp.statusCode).to.equal(200);
      done();
    });
  });

  it('ignores unexpected event types in requests', function (done) {
    var badbatch = _.cloneDeep(this.cxt.TEST_EVENTS_1);
    this.cxt.spEventFilter.unpackEvent(badbatch[0]).type = 'binglefloop';
    this.cxt.callWebhookEndpoint(badbatch, function (resp) {
      expect(resp.statusCode).to.equal(200);
      done();
    });
  });
});

