var chai = require('chai');
var sinon = require('sinon');
var sinonChai = require('sinon-chai');

var request = require('request');
var _ = require('lodash');

var appModule = require('../lib/app.js');
var appLib = appModule.App;
var appUtils = appModule.utils;
var rcptcacheLib = require('../lib/rcptcache');

chai.should();
chai.use(sinonChai);

var expect = chai.expect;

// ----------------------------------------------------------------------------

// Transmission API: reception, open, click, delivery
var TEST_EVENTS_1 = require('./testevents1.json');

// Transmission API: reception, tempfail, tempfail, inband
var TEST_EVENTS_2 = require('./testevents2.json');

var cxt;

function TestContext() {
  return {
    segmentStub: null,
    rcptcache: null,
    app: null,
    server: null,

    start: function(app, next) {
      this.segmentStub = {
        identify: sinon.spy(),
        track: sinon.spy(),
        flush: sinon.spy(function (next) {
          process.nextTick(next);
        })
      };
      this.rcptcache = new rcptcacheLib();
      this.app = new appLib(this.rcptcache, this.segmentStub);
      this.server = this.app.listen(3000, next);
    },

    stop: function (next) {
      this.server.close(next);
    }
  };
}

function callInboundEndpoint(events, next) {
  request({
    uri: 'http://localhost:3000/inbound',
    method: 'POST',
    json: events
  }).on('response', next);
}

function testResponseToEventTypes(eventset, evtTypes, next) {
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

  callInboundEndpoint(events, next);
}

function testPrep() {
  cxt = new TestContext();
  cxt.start();
}

function testCleanup(next) {
  cxt.stop(next ? next : function () {});
  cxt = null;
}
// ----------------------------------------------------------------------------
beforeEach('Start new webhook endpoint service', testPrep);
afterEach('Shutdown webhook endpoint service', testCleanup);

describe('SparkPost webhook endpoint', function () {
  it('/inbound accepts JSON POST requests', function (done) {
    callInboundEndpoint(TEST_EVENTS_1, function (resp) {
      expect(resp.statusCode).to.equal(200);
      done();
    });
  });

  it('returns 404 for other endpoints', function(done) {
    request('http://localhost:3000/jimbojumbochops').on('response', function(resp) {
      expect(resp.statusCode).to.equal(404);
      done();
    });
  });
});

describe('Segment.com client', function () {
  it('makes 1 segment.identify call per inbound email address', function (done) {
    testResponseToEventTypes(TEST_EVENTS_1, 'reception', function (resp) {
      cxt.app.flushSegmentCache(function () {
        cxt.segmentStub.identify.should.have.callCount(1);
        done();
      });
    });
  });

  it('makes 1 segment.track("Email Delivered") call for each received delivery event', function (done) {
    testResponseToEventTypes(TEST_EVENTS_1, ['reception', 'delivery'], function (resp) {
      cxt.app.flushSegmentCache(function () {
        cxt.segmentStub.track.should.have.callCount(1);
        expect(cxt.segmentStub.track).to.be.calledWith(sinon.match({event: 'Email Delivered'}));
        done();
      });
    });
  });

  it('makes 1 segment.track("Email Bounced") call for each received inband bounce event', function (done) {
    testResponseToEventTypes(TEST_EVENTS_2, ['reception', 'inband'], function (resp) {
      cxt.segmentStub.track.should.have.callCount(1);
      expect(cxt.segmentStub.track).to.be.calledWith(sinon.match({event: 'Email Bounced'}));
      cxt.app.flushSegmentCache();
      done();
    });
  });

  it.skip('makes 1 segment.track("Email Bounced") call for each received out_of_band event', function (done) {
    testResponseToEventTypes(TEST_EVENTS_2, ['reception', 'delivery', 'out_of_band'], function (resp) {
      cxt.segmentStub.track.should.have.callCount(2);
      expect(cxt.segmentStub.track).to.be.calledWith(sinon.match({event: 'Email Bounced'}));
      cxt.app.flushSegmentCache();
      done();
    });
  });

  it.skip('makes 1 segment.track("Email Marked as Spam") call for each received feedback/abuse event', function (done) {
    testResponseToEventTypes(TEST_EVENTS_1, ['reception', 'delivery', 'feedback'], function (resp) {
      cxt.segmentStub.track.should.have.callCount(2);
      expect(cxt.segmentStub.track).to.be.calledWith(sinon.match({event: 'Email Marked as Spam'}));
      cxt.app.flushSegmentCache();
      done();
    });
  });

  it('makes 1 segment.track("Email Opened") call for each received open event', function (done) {
    testResponseToEventTypes(TEST_EVENTS_1, ['reception', 'delivery', 'open'], function (resp) {
      cxt.segmentStub.track.should.have.callCount(2);
      expect(cxt.segmentStub.track).to.be.calledWith(sinon.match({event: 'Email Opened'}));
      cxt.app.flushSegmentCache();
      done();
    });
  });

  it('makes 1 segment.track("Email Link Clicked") call for each received click event', function (done) {
    testResponseToEventTypes(TEST_EVENTS_1, ['reception', 'delivery', 'open', 'click'], function (resp) {
      cxt.segmentStub.track.should.have.callCount(3);
      expect(cxt.segmentStub.track).to.be.calledWith(sinon.match({event: 'Email Link Clicked'}));
      cxt.app.flushSegmentCache();
      done();
    });
  });

  it('drops delivery events whose message_ids do not have cached rcpt_tos', function (done) {
    var evt = {
      msys: {
        message_event: {
          type: 'delivery',
          message_id: 'billyjoejimbob'
        }
      }
    }

    callInboundEndpoint([evt], function (resp) {
      expect(cxt.segmentStub.track.callCount).to.equal(0);
      done();
    });
  });

  it('drops open events whose message_ids do not have cached rcpt_tos', function (done) {
    testResponseToEventTypes(TEST_EVENTS_1, ['open'], function (resp) {
      cxt.segmentStub.track.should.have.callCount(0);
      cxt.app.flushSegmentCache();
      done();
    });
  });

  it('drops click events whose message_ids do not have cached rcpt_tos', function (done) {
    testResponseToEventTypes(TEST_EVENTS_1, ['click'], function (resp) {
      cxt.segmentStub.track.should.have.callCount(0);
      cxt.app.flushSegmentCache();
      done();
    });
  });

  it('is resilient to non-array json requests', function (done) {
    callInboundEndpoint({invalid:'object'}, function (resp) {
      expect(resp.statusCode).to.equal(500);
      done();
    });
  });

  it('quietly accepts empty json arrays in requests', function (done) {
    callInboundEndpoint([], function (resp) {
      expect(resp.statusCode).to.equal(200);
      done();
    });
  });

  it('ignores malformed events in requests', function (done) {
    var badbatch = _.cloneDeep(TEST_EVENTS_1);
    badbatch[0] = {invalid: 'object'};
    callInboundEndpoint(badbatch, function (resp) {
      expect(resp.statusCode).to.equal(200);
      done();
    });
  });

  it('ignores unexpected event types in requests', function (done) {
    var badbatch = _.cloneDeep(TEST_EVENTS_1);
    appUtils.unpackEvent(badbatch[0]).type = 'binglefloop';
    callInboundEndpoint(badbatch, function (resp) {
      expect(resp.statusCode).to.equal(200);
      done();
    });
  });
});
