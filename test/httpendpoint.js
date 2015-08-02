var chai = require('chai');
var sinon = require('sinon');
var sinonChai = require('sinon-chai');
var request = require('request');
var appLib = require('../lib/app.js').App;

chai.should();
chai.use(sinonChai);

var expect = chai.expect;

// ----------------------------------------------------------------------------

var TEST_EVENTS = require('../testevents.json');

var cxt;

function TestContext() {
  return {
    segmentStub: null,
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
      this.app = new appLib(this.segmentStub);
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

function testResponseToEventType(evtType, next) {
  var events = TEST_EVENTS.filter(function (elt) {
    return elt.msys.message_event && elt.msys.message_event.type == evtType;
  });

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

describe('SparkPost webhook endpoint', function () {
  before(testPrep);
  after(testCleanup);

  it('accepts JSON POST requests', function (done) {
    callInboundEndpoint(TEST_EVENTS, function (resp) {
      expect(resp.statusCode).to.equal(200);
      done();
    });
  });
});

describe('Segment.com client', function () {
  before(testPrep);
  after(testCleanup);

  it('makes 1 segment.identify call per inbound email address', function (done) {
    testResponseToEventType('delivery', function (resp) {
      cxt.app.flushSegmentCache(function () {
        cxt.segmentStub.identify.should.have.callCount(1);
        done();
      });
    });
  });

  it.skip('makes 1 segment.track("Email Delivered") call for each received delivery event', function (done) {
    testResponseToEventType('delivery', function (resp) {
      cxt.app.flushSegmentCache(function () {
        cxt.segmentStub.track.should.have.callCount(1);
        expect(cxt.segmentStub.track.getCall(0).args[0].event).to.equal('Email Delivered');
        done();
      });
    });
  });

  it.skip('makes 1 segment.track("Email Bounced") call for each received bounce event', function (done) {
    testResponseToEventType('bounce', function (resp) {
      cxt.segmentStub.track.should.have.callCount(1);
      expect(cxt.segmentStub.track.getCall(0).args[0].event).to.equal('Email Bounced');
      cxt.app.flushSegmentCache();
      done();
    });
  });

  it.skip('makes 1 segment.track("Email Bounced") call for each received out_of_band event', function (done) {
    testResponseToEventType('out_of_band', function (resp) {
      cxt.segmentStub.track.should.have.callCount(1);
      expect(cxt.segmentStub.track.getCall(0).args[0].event).to.equal('Email Bounced');
      cxt.app.flushSegmentCache();
      done();
    });
  });

  it.skip('makes 1 segment.track("Email Marked as Spam") call for each received feedback/abuse event', function (done) {
    testResponseToEventType('feedback', function (resp) {
      cxt.segmentStub.track.should.have.callCount(1);
      expect(cxt.segmentStub.track.getCall(0).args[0].event).to.equal('Email Marked as Spam');
      cxt.app.flushSegmentCache();
      done();
    });
  });

  it.skip('makes 1 segment.track("Email Opened") call for each received open event', function (done) {
    testResponseToEventType('open', function (resp) {
      cxt.segmentStub.track.should.have.callCount(1);
      expect(cxt.segmentStub.track.getCall(0).args[0].event).to.equal('Email Opened');
      cxt.app.flushSegmentCache();
      done();
    });
  });

  it.skip('makes 1 segment.track("Email Link Clicked") call for each received click event', function (done) {
    testResponseToEventType('click', function (resp) {
      cxt.segmentStub.track.should.have.callCount(1);
      expect(cxt.segmentStub.track.getCall(0).args[0].event).to.equal('Email Link Clicked');
      cxt.app.flushSegmentCache();
      done();
    });
  });

  it.skip('drops delivery events whose message_ids do not have cached rcpt_tos', function (done) {
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
    });
  });

  it('drops open events whose message_ids do not have cached rcpt_tos');
  it('drops click events whose message_ids do not have cached rcpt_tos');

  it('is resilient against non-array json requests');
  it('is resilient against empty json arrays in requests');
  it('is resilient against malformed events in requests');
  it('is resilient against unexpected event types in requests');
});
